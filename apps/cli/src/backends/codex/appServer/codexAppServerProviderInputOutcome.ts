import type {
    SessionProviderInputOutcomeObserver,
    SessionProviderInputOutcomeProducer,
} from '@/api/session/sessionClient';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { readPendingLocalId } from '@happier-dev/protocol';

function createCodexAppServerProviderInputProducer(
    isCurrentRuntimeMode: () => boolean,
    mode: 'appServer' | 'acp' | 'mcp' = 'appServer',
): SessionProviderInputOutcomeProducer {
    return Object.freeze({
        providerId: 'codex',
        mode,
        matchesCurrentSession: ({ metadata }) => {
            const flavor = metadata && typeof metadata === 'object'
                ? readNonBlankOpaqueIdentifier((metadata as Record<string, unknown>).flavor)
                : null;
            return flavor === 'codex' && isCurrentRuntimeMode();
        },
    });
}

type ProviderOutcomeBindingClient = Readonly<{
    bindProviderInputOutcomeProducer?: (
        producer: SessionProviderInputOutcomeProducer,
    ) => SessionProviderInputOutcomeObserver;
}>;

type CodexAppServerProviderInputAcceptance = Readonly<{
    localIds?: readonly string[] | null;
    providerTurnId: string;
    appliedModelId?: string | null;
}>;

export type CodexAppServerProviderInputOutcomeBridge = Readonly<{
    observeAccepted: (input: CodexAppServerProviderInputAcceptance) => boolean;
    observeAcceptedLocalInput: (input: Readonly<{
        localIds?: readonly string[] | null;
        delivery?: Readonly<{ kind: 'command' }>;
    }>) => boolean;
}>;

export type CodexAcpProviderInputOutcomeBridge = Readonly<{
    observeAccepted: (input: Readonly<{
        localIds?: readonly string[] | null;
        appliedModelId?: string | null;
        delivery?: Readonly<{ kind: 'command' }>;
    }>) => boolean;
}>;

function readExactAcceptance(input: CodexAppServerProviderInputAcceptance): Readonly<{
    localId: string;
    providerTurnId: string;
    appliedModelId?: string;
}> | null {
    if (input.localIds?.length !== 1) return null;
    const localId = readPendingLocalId(input.localIds[0]);
    const rawProviderTurnId = readNonBlankOpaqueIdentifier(input.providerTurnId);
    if (localId === null || !rawProviderTurnId) return null;
    const providerTurnId = rawProviderTurnId.trim();
    return {
        localId,
        providerTurnId,
        ...(readNonBlankOpaqueIdentifier(input.appliedModelId)
            ? { appliedModelId: readNonBlankOpaqueIdentifier(input.appliedModelId)! }
            : {}),
    };
}

function readExactLocalInput(localIds: readonly string[] | null | undefined): string | null {
    if (localIds?.length !== 1) return null;
    return readPendingLocalId(localIds[0]);
}

export function createCodexAppServerProviderInputOutcomeBridge(
    client: object,
    options: Readonly<{ isCurrentRuntimeMode: () => boolean }>,
): CodexAppServerProviderInputOutcomeBridge {
    const bindingClient = client as ProviderOutcomeBindingClient;
    const observe = bindingClient.bindProviderInputOutcomeProducer?.(
        createCodexAppServerProviderInputProducer(options.isCurrentRuntimeMode),
    ) ?? null;

    return Object.freeze({
        observeAccepted: (input) => {
            if (!observe) return false;
            const acceptance = readExactAcceptance(input);
            if (!acceptance) return false;
            observe({ kind: 'accepted', ...acceptance, delivery: { kind: 'primary_turn' } });
            return true;
        },
        observeAcceptedLocalInput: ({ localIds, delivery }) => {
            if (!observe) return false;
            const localId = readExactLocalInput(localIds);
            if (localId === null) return false;
            observe({ kind: 'accepted', localId, delivery: delivery ?? { kind: 'primary_turn' } });
            return true;
        },
    });
}

export function createCodexAcpProviderInputOutcomeBridge(
    client: object,
    mode: 'acp' | 'mcp' = 'acp',
): CodexAcpProviderInputOutcomeBridge {
    const bindingClient = client as ProviderOutcomeBindingClient;
    const observe = bindingClient.bindProviderInputOutcomeProducer?.(
        createCodexAppServerProviderInputProducer(() => true, mode),
    ) ?? null;
    return Object.freeze({
        observeAccepted: ({ localIds, appliedModelId, delivery }) => {
            if (!observe) return false;
            const localId = readExactLocalInput(localIds);
            if (localId === null) return false;
            const normalizedAppliedModelId = readNonBlankOpaqueIdentifier(appliedModelId);
            observe({
                kind: 'accepted',
                localId,
                ...(delivery ? { delivery } : {}),
                ...(normalizedAppliedModelId ? { appliedModelId: normalizedAppliedModelId } : {}),
            });
            return true;
        },
    });
}
