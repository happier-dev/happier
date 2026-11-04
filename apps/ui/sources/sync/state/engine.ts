import {
    createSessionStateSyncEngine,
    type SessionStateFieldWriteValue,
    type SessionStateMetadataWriteResult,
} from '@happier-dev/agents';
import type { SessionMetadata, SessionStateCapabilitiesV1, SessionStateFieldId, SessionStateFieldValue } from '@happier-dev/protocol';

import type { Metadata } from '@happier-dev/session-core/state';
import { createUiSessionStateMetadataUpdatePort } from './metadataUpdatePort';

const UI_SESSION_STATE_CAPABILITIES: SessionStateCapabilitiesV1 = {
    intent: {
        model: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        permissionMode: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        acpSessionMode: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        acpConfigOption: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        context: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        memoryEnabled: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        voicePreference: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        templateDraftRef: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        templateInstance: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    },
    display: {
        statusReason: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        title: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
        bot: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    },
    view: {
        transcriptToolCalls: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    },
};

export type UiSessionStateMetadataUpdater = (metadata: Metadata, metadataRevision?: number) => Metadata;
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
	}>): ReturnType<typeof createSessionStateSyncEngine> {
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
	                        (metadata, metadataRevision) => {
	                            const preparedMetadata = metadataPreprocess
	                                ? metadataPreprocess(metadata as Metadata)
	                                : metadata as Metadata;
	                            return metadataPostprocess(updater(preparedMetadata, metadataRevision) as Metadata) as SessionMetadata;
	                        },
	                        opts,
	                    ),
	            }
	            : metadataPreprocess
	                ? {
	                    update: (sessionId, updater, opts) =>
	                        basePort.update(
	                            sessionId,
	                            (metadata, metadataRevision) => updater(metadataPreprocess(metadata as Metadata), metadataRevision) as SessionMetadata,
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
    expectedMetadataRevision?: number;
    expectedValue?: SessionStateFieldValue<F> | null;
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
        expectedMetadataRevision: params.expectedMetadataRevision,
        expectedValue: params.expectedValue,
        ...(typeof params.maxAttempts === 'number' ? { maxAttempts: params.maxAttempts } : {}),
        mirrorToProvider: false,
    });
}
