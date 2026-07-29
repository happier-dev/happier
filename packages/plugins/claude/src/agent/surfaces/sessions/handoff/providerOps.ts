import type { HandoffSurfaceV1, SessionStateUpdateV1 } from '@happier-dev/plugin-sdk/experimental/sessions';
import { PluginError } from '@happier-dev/plugin-sdk';
import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/plugin-sdk/experimental/sessions';

import {
    exportClaudeSessionBundle,
    importClaudeSessionBundle,
} from './bundle.js';
import { ClaudeSessionBundleSchema } from './types.js';

export const claudeHandoffSurface = {
    exportBundle: async (params) => {
        const metadata = params.metadata as Record<string, unknown>;
        const remoteSessionId = resolveVendorResumeIdFromSessionMetadata('claude', metadata);
        if (!remoteSessionId) {
            return { ok: false, code: 'bundle_invalid', message: 'Claude handoff export requires a vendor session id' };
        }
        try {
            const bundle = await exportClaudeSessionBundle({
                metadata,
                remoteSessionId,
                env: process.env,
            });
            return { ok: true, value: { bundle } };
        } catch (error) {
            return {
                ok: false,
                code: 'handoff_failed',
                message: error instanceof Error ? error.message : 'Claude handoff export failed',
            };
        }
    },
    importBundle: async (params) => {
        const parsedBundle = ClaudeSessionBundleSchema.safeParse(params.bundle);
        if (!parsedBundle.success) {
            return { ok: false, code: 'bundle_invalid', message: 'Invalid Claude session handoff bundle' };
        }
        try {
            const imported = await importClaudeSessionBundle({
                bundle: parsedBundle.data,
                targetPath: params.targetDirectory,
                env: process.env,
            });
            const sessionStateUpdates: SessionStateUpdateV1[] = [
                {
                    fieldId: 'identity.providerSessionId',
                    value: imported.remoteSessionId,
                },
            ];
            return {
                ok: true,
                value: {
                    providerSessionId: imported.remoteSessionId,
                    source: imported.directSource,
                    launch: {
                        directory: imported.resume.directory,
                        ...(imported.resume.environmentVariables ? { environmentVariables: imported.resume.environmentVariables } : {}),
                        sessionStateUpdates,
                    },
                },
            };
        } catch (error) {
            if (error instanceof PluginError && error.code === 'target_identity_conflict') {
                return {
                    ok: false,
                    code: 'target_identity_conflict',
                    message: error.message,
                    retryable: error.retryable,
                };
            }
            return {
                ok: false,
                code: 'target_import_failed',
                message: error instanceof Error ? error.message : 'Claude handoff import failed',
            };
        }
    },
} satisfies HandoffSurfaceV1;
