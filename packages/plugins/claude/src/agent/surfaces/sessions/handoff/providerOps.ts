import type { HandoffSurfaceV1, SessionStateUpdateV1 } from '@happier-dev/agents';
import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';

import {
    exportClaudeSessionBundle,
    importClaudeSessionBundle,
} from './bundle.js';
import type { ClaudeSessionBundle } from './types.js';

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
        const bundle = params.bundle as Partial<ClaudeSessionBundle>;
        if (bundle.providerId !== 'claude') {
            return { ok: false, code: 'bundle_invalid', message: 'Claude handoff import received unsupported bundle' };
        }
        try {
            const imported = await importClaudeSessionBundle({
                bundle: bundle as ClaudeSessionBundle,
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
            return {
                ok: false,
                code: 'target_import_failed',
                message: error instanceof Error ? error.message : 'Claude handoff import failed',
            };
        }
    },
} satisfies HandoffSurfaceV1;
