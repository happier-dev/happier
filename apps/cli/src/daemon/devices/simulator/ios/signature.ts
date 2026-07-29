import { defaultSimulatorToolRunner, type SimulatorToolRunner } from '../process';
import type { IosSimulatorHelperSignatureResult } from './helperArtifact';

const SIGNATURE_VERIFY_TIMEOUT_MS = 30_000;

export type VerifyIosSimulatorHelperSignatureInput = Readonly<{
    path: string;
    platform?: NodeJS.Platform | string;
    /** Require a stapled notarization ticket (offline Gatekeeper trust). */
    requireStaple?: boolean;
    runTool?: SimulatorToolRunner;
    timeoutMs?: number;
}>;

function failure(
    reasonCode: string,
    diagnostics: readonly Record<string, unknown>[] = [],
): IosSimulatorHelperSignatureResult {
    return { ok: false, reasonCode, diagnostics };
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Real Developer ID / Gatekeeper signature verifier for the vendored iOS simulator helper.
 *
 * Fail-closed by construction: trust is derived only from a daemon-side `codesign`/`spctl`
 * (and optional `stapler`) assessment of the bytes on disk — never from a caller-asserted
 * result. Any non-macOS host, non-zero exit, or runner error yields a typed failure so the
 * artifact resolver downgrades to `helper_artifact_unsigned`.
 */
export async function verifyIosSimulatorHelperSignature(
    input: VerifyIosSimulatorHelperSignatureInput,
): Promise<IosSimulatorHelperSignatureResult> {
    const platform = input.platform ?? process.platform;
    if (platform !== 'darwin') {
        return failure('signature_verifier_unsupported_host', [{
            code: 'signature_verifier_unsupported_host',
            platform,
        }]);
    }

    const runTool = input.runTool ?? defaultSimulatorToolRunner;
    const timeoutMs = input.timeoutMs ?? SIGNATURE_VERIFY_TIMEOUT_MS;

    try {
        const codesign = await runTool({
            command: 'codesign',
            args: ['--verify', '--strict', '--deep', input.path],
            timeoutMs,
        });
        if (codesign.exitCode !== 0) {
            return failure('codesign_verify_failed', [{
                code: 'codesign_verify_failed',
                exitCode: codesign.exitCode,
                ...(codesign.timedOut ? { timedOut: true } : {}),
            }]);
        }

        const spctl = await runTool({
            command: 'spctl',
            args: ['--assess', '--type', 'execute', '--verbose=2', input.path],
            timeoutMs,
        });
        if (spctl.exitCode !== 0) {
            return failure('spctl_assess_rejected', [{
                code: 'spctl_assess_rejected',
                exitCode: spctl.exitCode,
                ...(spctl.timedOut ? { timedOut: true } : {}),
            }]);
        }

        if (input.requireStaple) {
            const stapler = await runTool({
                command: 'stapler',
                args: ['validate', input.path],
                timeoutMs,
            });
            if (stapler.exitCode !== 0) {
                return failure('stapler_validate_failed', [{
                    code: 'stapler_validate_failed',
                    exitCode: stapler.exitCode,
                    ...(stapler.timedOut ? { timedOut: true } : {}),
                }]);
            }
        }

        return { ok: true };
    } catch (error) {
        return failure('signature_verifier_failed', [{
            code: 'signature_verifier_failed',
            errorName: errorName(error),
        }]);
    }
}
