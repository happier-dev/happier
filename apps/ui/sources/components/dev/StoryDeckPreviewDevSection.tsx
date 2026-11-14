import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ReleaseNotesStorySurface, type ReleaseNotesStorySurfaceProps } from '@/components/changelog/releaseNotes';
import { Modal } from '@/modal';
import { Icon } from '@/components/ui/icons/Icon';
import {
    getActiveManifest,
    getReleaseNotesRuntimeVersion,
    subscribeReleaseNotesRuntime,
    type ReleaseNotesRelease,
} from '@/changelog/releaseNotes';

type ReleaseNotesPreviewState = Readonly<{
    latestReleaseId: string | null;
    releases: readonly ReleaseNotesRelease[];
}>;

function useReleaseNotesPreviewState(): ReleaseNotesPreviewState {
    const runtimeVersion = React.useSyncExternalStore(
        subscribeReleaseNotesRuntime,
        getReleaseNotesRuntimeVersion,
        getReleaseNotesRuntimeVersion,
    );

    return React.useMemo(() => {
        const manifest = getActiveManifest();
        return {
            latestReleaseId: manifest?.latestReleaseId ?? null,
            releases: manifest?.releases ?? [],
        };
    }, [runtimeVersion]);
}

function showPreviewModal(params: Readonly<{
    component: typeof ReleaseNotesStorySurface;
    buildProps: (close: () => void) => ReleaseNotesStorySurfaceProps;
}>): void {
    let modalId: string | null = null;
    const close = () => {
        if (!modalId) return;
        Modal.hide(modalId);
        modalId = null;
    };

    modalId = Modal.show({
        component: params.component,
        phonePresentation: 'sheet',
        onRequestClose: close,
        props: params.buildProps(close),
    });
}

export function StoryDeckPreviewDevSection() {
    const router = useRouter();
    const { latestReleaseId, releases } = useReleaseNotesPreviewState();
    const { theme } = useUnistyles();
    const accentColor = theme.colors.accent.blue;

    const openReleasePreview = React.useCallback((release: ReleaseNotesRelease) => {
        showPreviewModal({
            component: ReleaseNotesStorySurface,
            buildProps: (close) => ({
                release,
                onComplete: close,
                onDismiss: close,
                onViewFullChangelog: () => {
                    close();
                    router.push('/changelog');
                },
                testID: `dev-release-notes-story-preview:${release.releaseId}`,
            }),
        });
    }, [router]);

    return (
        <ItemGroup
            title="Story Deck Preview"
            description="Preview surfaces without changing onboarding or release-note seen state."
            selectableItemCountOverride={releases.length === 0 ? 1 : releases.length}
        >
            {releases.length === 0 ? (
                <Item
                    testID="dev-story-deck-preview-empty"
                    title="No release notes available"
                    subtitle="Add authored release notes and run parseReleaseNotes to generate the manifest."
                    icon={<Icon name="stack" size={29} color={theme.colors.text.tertiary} />}
                    mode="info"
                    showChevron={false}
                />
            ) : releases.map((release) => (
                <Item
                    key={release.releaseId}
                    testID={`dev-story-deck-preview-release:${release.releaseId}`}
                    title={release.versionLabel || release.releaseId}
                    subtitle={`${release.cards.length} cards · ${release.releaseId}`}
                    detail={release.releaseId === latestReleaseId ? 'Latest' : undefined}
                    icon={<Icon name="newspaper" size={29} color={accentColor} />}
                    onPress={() => openReleasePreview(release)}
                />
            ))}
        </ItemGroup>
    );
}
