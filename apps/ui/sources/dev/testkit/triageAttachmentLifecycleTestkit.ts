import { randomUUID } from 'node:crypto';
import { afterEach, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { createNewSessionComposerDocumentOwner } from '@/components/sessions/composer/newSessionComposerDocumentOwner';
import { projectComposerAttachmentRowItems } from '@/components/sessions/composer/composerAttachmentProjection';
import { projectComposerDocumentSnapshot } from '@/components/sessions/composer/composerSnapshotProjection';
import {
    applyComposerPresentationTransaction,
    createComposerPresentationTransactionApplier,
    registerComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { standardCleanup } from '@/dev/testkit';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import {
    parseDaemonContributionRegistryProjectionDescribeResponse,
    type DaemonContributionRegistryProjectionDescribeParsedResponse,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { getStorage } from '@/sync/domains/state/storageStore';
import { prepareLocalSessionDraftScope } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(standardCleanup);

type CreateFixture = typeof import('./triageAttachmentLifecycleTestkit.d.mts').createTriageAttachmentLifecycleFixture;

export const createTriageAttachmentLifecycleFixture: CreateFixture = async ({ scope, identity, text }) => {
    const storage = await activateStorageAccountScope(scope, getStorage());
    try {
        await prepareLocalSessionDraftScope(scope);
        const owner = createNewSessionComposerDocumentOwner({ scope, ref: { kind: 'newSession', instanceId: 'retained-triage-draft' } });
        owner.replaceDocument({ text, structuredInputMentions: [], composerAttachments: [] });
        const attachmentKey = `${identity.pluginId}/${identity.localId}`;
        let projection = normalizePluginUiProjection(null, 'web');
        let catalog: DaemonContributionRegistryProjectionDescribeParsedResponse['composerSurfaceCatalog'];
        const readSnapshot = () => projectComposerDocumentSnapshot({
            owner,
            attachmentCatalog: { entriesById: projection.composerAttachmentsById },
            presentation: { layout: 'wrap', focused: false, editable: true, submittable: true, submitting: false, running: false },
        });
        const unregister = registerComposerPresentationTarget(owner.ref, {
            readScope: () => scope,
            readRevision: () => owner.read().revision,
            replace: () => owner.read().revision,
            readSnapshot,
            createAttachmentInstanceId: randomUUID,
            commitDocument: ({ expectedRevision, mutation }) => owner.apply(expectedRevision, mutation),
        });
        return {
            readProjection(raw) {
                const response = parseDaemonContributionRegistryProjectionDescribeResponse(raw);
                if (!response) throw new Error('Daemon projection failed UI ingress');
                projection = normalizePluginUiProjection(response.projection, 'web');
                catalog = response.composerSurfaceCatalog;
            },
            readPicker: () => catalog?.find(entry => entry.contribution.pluginId === identity.pluginId
                && entry.contribution.localId === identity.localId && entry.role === 'attachmentPicker'),
            readOccurrenceId: () => projection.composerAttachmentsById[attachmentKey]?.occurrenceId,
            readSnapshot,
            readDocument: () => owner.read().document,
            apply(transaction) {
                const declaration = projection.composerAttachmentsById[attachmentKey];
                if (!declaration) throw new Error('Current daemon Triage attachment declaration missing');
                return createComposerPresentationTransactionApplier({ scope, composerAttachmentsById: projection.composerAttachmentsById }).apply({
                    ref: owner.ref,
                    transaction,
                    admittedContributor: { identity: declaration.identity, occurrenceId: declaration.occurrenceId },
                });
            },
            readAttachmentRows: () => projectComposerAttachmentRowItems({
                attachments: readSnapshot().attachments,
                entriesById: projection.composerAttachmentsById,
                onRemove: instanceId => {
                    expect(applyComposerPresentationTransaction({ ref: owner.ref, transaction: {
                        expectedRevision: owner.read().revision,
                        operations: [{ kind: 'attachment.remove', instanceId }],
                    } })).toMatchObject({ status: 'applied' });
                },
            }),
            dispose() {
                unregister();
                storage.dispose();
            },
        };
    } catch (error) {
        storage.dispose();
        throw error;
    }
};
