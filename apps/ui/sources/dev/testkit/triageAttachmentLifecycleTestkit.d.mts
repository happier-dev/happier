import type { DaemonPluginUiComposerSurfaceCatalogEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiContributionIdentityV1 } from '@happier-dev/plugin-sdk/ui';
import type {
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
    ComposerTransactionV1,
} from '@happier-dev/protocol/plugins/ui/composer';
import type { ComposerAttachmentDraftV1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';

export function createTriageAttachmentLifecycleFixture(input: Readonly<{
    scope: Readonly<{ serverId: string; accountId: string }>;
    identity: PluginUiContributionIdentityV1;
    text: string;
}>): Promise<Readonly<{
    readProjection(raw: unknown): void;
    readPicker(): DaemonPluginUiComposerSurfaceCatalogEntryV1 | undefined;
    readOccurrenceId(): string | undefined;
    readSnapshot(): ComposerSnapshotV1;
    readDocument(): Readonly<{
        text: string;
        structuredInputMentions: readonly unknown[];
        composerAttachments: readonly ComposerAttachmentDraftV1[];
    }>;
    apply(transaction: ComposerTransactionV1): ComposerTransactionResultV1;
    readAttachmentRows(): readonly Readonly<{
        kind: 'badge' | 'media' | 'surface';
        label: string;
        onPress?: () => void;
        onRemove?: () => void;
    }>[];
    dispose(): void;
}>>;
