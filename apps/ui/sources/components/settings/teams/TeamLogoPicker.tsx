import * as React from 'react';
import { File } from 'expo-file-system';
import type { TeamLogoSourceV1, TeamSummaryV1 } from '@happier-dev/protocol/teams';

import { useUnistyles } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import {
    TEAM_LOGO_ACCEPTED_MIME_TYPES,
    createTeamLogoSource,
} from '@/sync/domains/teams/teamLogoSource';
import { t } from '@/text';
import { nativePickImages } from '@/utils/files/nativePickImages';

const LOGO_PREVIEW_SIZE = 44;

/**
 * The accepted formats as a person recognises them, read from the media
 * boundary's own list rather than restated here. The platform picker cannot be
 * narrowed to these types, so a rejection is the first moment we can say which
 * files this Home will take — and saying it then is what turns a dead end into
 * one more pick.
 */
const ACCEPTED_LOGO_FORMATS = TEAM_LOGO_ACCEPTED_MIME_TYPES
    .map((mimeType) => (mimeType.split('/')[1] ?? mimeType).toUpperCase())
    .join(', ');

type LogoCommitResult =
    | Readonly<{ kind: 'succeeded' }>
    | Readonly<{ kind: 'failed'; message: string }>;

/** Reads a picked image without assuming a platform-specific file API. */
async function readPickedImageBytes(
    picked: Awaited<ReturnType<typeof nativePickImages>>[number],
): Promise<Readonly<{ bytes: Uint8Array; mimeType: string | null }>> {
    if (picked.kind === 'web') {
        return {
            bytes: new Uint8Array(await picked.file.arrayBuffer()),
            mimeType: picked.file.type || null,
        };
    }
    return { bytes: await new File(picked.uri).bytes(), mimeType: picked.mimeType };
}

function sourceUri(source: TeamLogoSourceV1): string {
    return `data:${source.mimeType};base64,${source.dataBase64}`;
}

/**
 * The single Team-logo selection journey shared by create and settings.
 *
 * Picking never uploads. The selected bytes first render through the same
 * square center-cover Avatar presentation used after publication, and only the
 * explicit Use action asks the caller to commit them. A failed commit keeps the
 * local candidate so retry never asks the person to pick the file again.
 *
 * It is one row — the preview, what it shows, and its actions — that the caller places in its
 * section; a refusal replaces the row's description until the next pick.
 */
export const TeamLogoPicker = React.memo(function TeamLogoPicker(props: Readonly<{
    identityId: string;
    testIDPrefix: string;
    currentLogo: TeamSummaryV1['logo'];
    selectedSource?: TeamLogoSourceV1 | null;
    disabled: boolean;
    onUse: (
        source: TeamLogoSourceV1,
        onSettled: (result: LogoCommitResult) => void,
    ) => Promise<LogoCommitResult | Readonly<{ kind: 'pending' }>>;
    /** Removes the published logo (settings); offered while no new image is being chosen. */
    remove?: Readonly<{ onPress: () => void; busy: boolean; disabled: boolean; error: string | null }>;
}>) {
    const { theme } = useUnistyles();
    const [candidate, setCandidate] = React.useState<TeamLogoSourceV1 | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const useInFlightRef = React.useRef(false);

    React.useEffect(() => () => {
        useInFlightRef.current = false;
    }, []);

    const pick = React.useCallback(async () => {
        setError(null);
        try {
            const picked = await nativePickImages({ multiple: false });
            const first = picked[0];
            if (!first) return;
            const read = await readPickedImageBytes(first);
            const source = createTeamLogoSource({ bytes: read.bytes, mimeType: read.mimeType });
            if (source.status === 'invalid') {
                setError(source.reason === 'too_large'
                    ? t('teams.logo.tooLarge')
                    : t('teams.logo.invalidFormat', { formats: ACCEPTED_LOGO_FORMATS }));
                return;
            }
            setCandidate(source.source);
        } catch {
            setError(t('teams.logo.failed'));
        }
    }, []);

    const use = React.useCallback(async () => {
        if (!candidate || props.disabled || useInFlightRef.current) return;
        useInFlightRef.current = true;
        setBusy(true);
        setError(null);
        try {
            const settle = (result: LogoCommitResult) => {
                if (result.kind === 'succeeded') {
                    setCandidate(null);
                    setError(null);
                } else setError(result.message);
            };
            const result = await props.onUse(candidate, settle);
            if (result.kind !== 'pending') settle(result);
        } catch {
            setError(t('teams.logo.failed'));
        } finally {
            useInFlightRef.current = false;
            setBusy(false);
        }
    }, [candidate, props]);

    const previewSource = candidate ?? props.selectedSource ?? null;
    const imageUrl = previewSource ? sourceUri(previewSource) : props.currentLogo?.url ?? null;
    const thumbhash = previewSource ? null : props.currentLogo?.thumbhash ?? null;

    const actions = candidate ? (
        <SectionButtonRow>
            <RoundButton
                testID={`${props.testIDPrefix}-logo-cancel`}
                size="small"
                display="inverted"
                title={t('common.cancel')}
                disabled={props.disabled || busy}
                onPress={() => { setCandidate(null); setError(null); }}
            />
            <RoundButton
                testID={`${props.testIDPrefix}-logo-use`}
                size="small"
                display="secondary"
                title={error ? t('teams.logo.retry') : t('teams.logo.useAsLogo')}
                loading={busy}
                disabled={props.disabled || busy}
                onPress={() => void use()}
            />
        </SectionButtonRow>
    ) : (
        <SectionButtonRow>
            {props.remove && props.currentLogo ? (
                <RoundButton
                    testID={`${props.testIDPrefix}-logo-remove`}
                    size="small"
                    display="inverted"
                    title={t('teams.logo.remove')}
                    loading={props.remove.busy}
                    disabled={props.remove.disabled}
                    onPress={props.remove.onPress}
                />
            ) : null}
            <RoundButton
                testID={`${props.testIDPrefix}-logo-set`}
                size="small"
                display="secondary"
                title={imageUrl ? t('teams.logo.replace') : t('teams.logo.add')}
                disabled={props.disabled || busy}
                onPress={() => void pick()}
            />
        </SectionButtonRow>
    );
    const shownError = error ?? props.remove?.error ?? null;

    return (
        <Item
            testID={`${props.testIDPrefix}-logo-preview`}
            title={t('teams.settings.logoSection')}
            subtitle={shownError ?? (imageUrl ? t('teams.logo.previewLabel') : t('teams.logo.monogramLabel'))}
            subtitleStyle={shownError ? { color: theme.colors.state.danger.foreground } : undefined}
            subtitleLines={0}
            leftElement={(
                <Avatar
                    id={props.identityId}
                    square
                    size={LOGO_PREVIEW_SIZE}
                    imageUrl={imageUrl}
                    thumbhash={thumbhash}
                />
            )}
            accessoryLayout="adaptive"
            rightElement={actions}
            showChevron={false}
        />
    );
});
