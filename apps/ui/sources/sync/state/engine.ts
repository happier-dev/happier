import {
    createSessionStateSyncEngine,
    type SessionStateFieldWriteValue,
    type SessionStateMetadataWriteResult,
} from '@happier-dev/agents';
import type { SessionMetadata, SessionStateCapabilitiesV1, SessionStateFieldId } from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { createUiSessionStateMetadataUpdatePort } from './metadataUpdatePort';

const UI_SESSION_STATE_CAPABILITIES: SessionStateCapabilitiesV1 = {
    intent: {
        model: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        permissionMode: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        acpSessionMode: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        acpConfigOption: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    },
    display: {
        title: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    },
};

export type UiSessionStateMetadataUpdater = (metadata: Metadata) => Metadata;
export type UiSessionStateMetadataPreprocess = (metadata: Metadata) => Metadata;
export type UiSessionStateMetadataPostprocess = (metadata: Metadata) => Metadata;
export type UiSessionStateWriteResult = SessionStateMetadataWriteResult;

export function createUiSessionStateEngine(params: Readonly<{
	    updateSessionMetadataWithRetry: (
	        sessionId: string,
	        updater: UiSessionStateMetadataUpdater,
	        opts?: Readonly<{ maxAttempts?: number }>,
	    ) => Promise<unknown>;
	    metadataPreprocess?: UiSessionStateMetadataPreprocess;
	    metadataPostprocess?: UiSessionStateMetadataPostprocess;
	}>) {
    const basePort = createUiSessionStateMetadataUpdatePort({
        updateSessionMetadataWithRetry: params.updateSessionMetadataWithRetry,
    });
	    const metadataPreprocess = params.metadataPreprocess;
	    const metadataPostprocess = params.metadataPostprocess;

    return createSessionStateSyncEngine({
        capabilities: UI_SESSION_STATE_CAPABILITIES,
        facet: null,
        metadataPort: metadataPostprocess
            ? {
	                update: (sessionId, updater, opts) =>
	                    basePort.update(
	                        sessionId,
	                        (metadata) => {
	                            const preparedMetadata = metadataPreprocess
	                                ? metadataPreprocess(metadata as Metadata)
	                                : metadata as Metadata;
	                            return metadataPostprocess(updater(preparedMetadata) as Metadata) as SessionMetadata;
	                        },
	                        opts,
	                    ),
	            }
	            : metadataPreprocess
	                ? {
	                    update: (sessionId, updater, opts) =>
	                        basePort.update(
	                            sessionId,
	                            (metadata) => updater(metadataPreprocess(metadata as Metadata)) as SessionMetadata,
	                            opts,
	                        ),
	                }
	            : basePort,
    });
}

export async function writeUiSessionStateField<F extends SessionStateFieldId>(params: Readonly<{
    sessionId: string;
    fieldId: F;
    value: SessionStateFieldWriteValue<F>;
    metadataReason: string;
	    updateSessionMetadataWithRetry: (
	        sessionId: string,
	        updater: UiSessionStateMetadataUpdater,
	        opts?: Readonly<{ maxAttempts?: number }>,
	    ) => Promise<unknown>;
	    metadataPreprocess?: UiSessionStateMetadataPreprocess;
	    metadataPostprocess?: UiSessionStateMetadataPostprocess;
    maxAttempts?: number;
}>): Promise<UiSessionStateWriteResult> {
	    const engine = createUiSessionStateEngine({
	        updateSessionMetadataWithRetry: params.updateSessionMetadataWithRetry,
	        ...(params.metadataPreprocess ? { metadataPreprocess: params.metadataPreprocess } : {}),
	        ...(params.metadataPostprocess ? { metadataPostprocess: params.metadataPostprocess } : {}),
	    });

    return await engine.writeHappierField({
        sessionId: params.sessionId,
        fieldId: params.fieldId,
        value: params.value,
        reason: 'user-mutation',
        metadataReason: params.metadataReason,
        ...(typeof params.maxAttempts === 'number' ? { maxAttempts: params.maxAttempts } : {}),
        mirrorToProvider: false,
    });
}
