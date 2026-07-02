import { RPC_METHODS } from '@happier-dev/protocol/rpc';

export type InternalOnlyRpcMethodEntry = Readonly<{
    method: string;
    rationale: string;
    ownerPacket: string;
    reviewNote?: string;
}>;

export type InternalOnlyRpcMethodValidationIssue = Readonly<{
    code:
        | 'missing-method'
        | 'missing-rationale'
        | 'missing-owner-packet'
        | 'duplicate-method';
    method?: string;
    message: string;
}>;

export type InternalOnlyRpcMethodValidationResult = Readonly<{
    ok: boolean;
    errors: readonly InternalOnlyRpcMethodValidationIssue[];
}>;

const PROMPT_TRANSFER_CONTROL_RATIONALE =
    'Prompt transfer control-plane transport uses session/chunk envelopes and remains internal transport, not an ActionSpec action surface.';
const VOICE_INFERENCE_MODEL_ADMIN_RATIONALE =
    'A.12 voice cleanup keeps daemon voice inference model install/remove/warm calls as bounded daemon-local admin RPC, not an ActionSpec action surface.';
const VOICE_INFERENCE_TRANSPORT_RATIONALE =
    'A.12 voice cleanup keeps daemon voice inference TTS/STT request, transfer, and cancellation calls as bounded internal transport, not an ActionSpec action surface.';

// A.12.0 seeds only clearly internal lifecycle transport methods.
// Downstream A.12 domain packets append their own rows when a method is proven
// internal-only rather than action-backed.
export const INTERNAL_ONLY_RPC_METHODS = Object.freeze([
    {
        method: RPC_METHODS.STOP_DAEMON,
        rationale: 'Daemon lifecycle shutdown transport; not a plugin-exposed action surface.',
        ownerPacket: 'A.12.0',
    },
    {
        method: RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
        rationale: VOICE_INFERENCE_MODEL_ADMIN_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE,
        rationale: VOICE_INFERENCE_MODEL_ADMIN_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM,
        rationale: VOICE_INFERENCE_MODEL_ADMIN_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL,
        rationale: VOICE_INFERENCE_TRANSPORT_RATIONALE,
        ownerPacket: 'A.12-voice-cleanup',
    },
    {
        method: RPC_METHODS.DAEMON_EXTENSIONS_RELOAD_STATUS,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_ABORT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_ABORT,
        rationale: PROMPT_TRANSFER_CONTROL_RATIONALE,
        ownerPacket: 'A.12-daemon-admin',
    },
    {
        method: RPC_METHODS.SCM_BACKEND_DESCRIBE,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
    {
        method: RPC_METHODS.CAPABILITIES_DESCRIBE,
        rationale: 'PMS-5 direct-eligible daemon read projection; remains internal transport, not a public action surface.',
        ownerPacket: 'PMS-5',
    },
] satisfies readonly InternalOnlyRpcMethodEntry[]);

function normalizeMethod(value: string): string {
    return value.trim();
}

export function validateInternalOnlyRpcMethodEntries(
    entries: readonly InternalOnlyRpcMethodEntry[] = INTERNAL_ONLY_RPC_METHODS,
): InternalOnlyRpcMethodValidationResult {
    const seen = new Set<string>();
    const errors: InternalOnlyRpcMethodValidationIssue[] = [];

    for (const entry of entries) {
        const method = normalizeMethod(entry.method);
        if (!method) {
            errors.push({
                code: 'missing-method',
                message: 'Internal-only RPC entries must declare a non-empty method.',
            });
            continue;
        }

        if (seen.has(method)) {
            errors.push({
                code: 'duplicate-method',
                method,
                message: `Internal-only RPC method is declared more than once: ${method}`,
            });
        }
        seen.add(method);

        if (!entry.rationale.trim()) {
            errors.push({
                code: 'missing-rationale',
                method,
                message: `Internal-only RPC method requires a non-empty rationale: ${method}`,
            });
        }

        if (!entry.ownerPacket.trim()) {
            errors.push({
                code: 'missing-owner-packet',
                method,
                message: `Internal-only RPC method requires an owner packet: ${method}`,
            });
        }
    }

    return {
        ok: errors.length === 0,
        errors,
    };
}

export function getInternalOnlyRpcMethodEntry(
    method: string,
    entries: readonly InternalOnlyRpcMethodEntry[] = INTERNAL_ONLY_RPC_METHODS,
): InternalOnlyRpcMethodEntry | null {
    const normalized = normalizeMethod(method);
    return entries.find((entry) => normalizeMethod(entry.method) === normalized) ?? null;
}

export function isInternalOnlyRpcMethod(
    method: string,
    entries: readonly InternalOnlyRpcMethodEntry[] = INTERNAL_ONLY_RPC_METHODS,
): boolean {
    return getInternalOnlyRpcMethodEntry(method, entries) !== null;
}
