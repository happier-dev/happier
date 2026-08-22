import type {
    AgentRuntimeHandoffSurface,
    AgentTerminalSessionStateUpdate,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import {
    exportClaudeSessionBundle,
    importClaudeSessionBundle,
} from './bundle.js';
import { ClaudeSessionBundleSchema } from './types.js';

export const claudeHandoffSurface = {
    exportBundle: async (params, context) => {
        const remoteSessionId = params.sessionId.trim() || null;
        if (!remoteSessionId) {
            return { ok: false, code: 'bundle_invalid', message: 'Claude handoff export requires a vendor session id' };
        }
        try {
            const bundle = await exportClaudeSessionBundle({
                metadata: params.metadata,
                remoteSessionId,
                env: process.env,
                signal: context.signal,
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
    importBundle: async (params, context) => {
        const parsedBundle = ClaudeSessionBundleSchema.safeParse(params.bundle);
        if (!parsedBundle.success) {
            return { ok: false, code: 'bundle_invalid', message: 'Invalid Claude session handoff bundle' };
        }
        try {
            const imported = await importClaudeSessionBundle({
                bundle: parsedBundle.data,
                targetPath: params.targetDirectory,
                env: process.env,
                signal: context.signal,
            });
            const sessionStateUpdates: AgentTerminalSessionStateUpdate[] = [
                {
                    fieldId: 'identity.providerSessionId',
                    value: imported.providerSessionId,
                },
            ];
            return {
                ok: true,
                value: {
                    providerSessionId: imported.providerSessionId,
                    source: imported.directSource,
                    launch: {
                        ...imported.launch,
                        sessionStateUpdates,
                    },
                },
            };
        } catch (error) {
            if (isPluginError(error) && error.code === 'target_identity_conflict') {
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
} satisfies AgentRuntimeHandoffSurface;
