import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import type { ShareSheetHost, SharePrincipalPresentation } from '@happier-dev/plugin-ui/components';
import { SelectionList, createDefaultDynamicSectionCache } from '@/components/ui/selectionList';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { useDeviceType } from '@/utils/platform/responsive';
import { resolvePublicShareApplicationBaseUrl } from '@/components/sessions/sharing/publicShareApplicationUrl';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSharePresentationHost, useShareGrantRowPresentation, ShareSheetButton } from './sharePresentationHost';
const styles = StyleSheet.create(theme => ({
    helpLine: { color: theme.colors.text.secondary },
    description: { color: theme.colors.text.secondary, paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s16 },
}));
function SharePrincipalVisual(props: Readonly<{ principal: SharePrincipalPresentation; testID: string; size?: number }>): React.ReactElement {
    const { principal } = props;
    const { theme } = useUnistyles();
    const size = props.size ?? ICON_SIZE.lg;
    return <View testID={props.testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {principal.ref.kind === 'account'
            ? <Avatar id={principal.avatar?.id ?? principal.key} size={size} imageUrl={principal.avatar?.imageUrl ?? null} />
            : <Icon name="users" size={size} color={theme.colors.text.secondary} />}
    </View>;
}

function ShareHandoffIcon(props: Readonly<{ name: 'link' | 'copy' }>): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name={props.name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
}

function ShareHelpIcon(): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name="info" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
}

function ShareDirectoryIcon(): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name="users" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />;
}

function ShareAddIcon(): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name="plus" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
}

function SharePublicLinkState(props: Readonly<{ stateLabel: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    return <View style={{ flexDirection: 'row', alignItems: 'center', gap: PAGE_LIST_METRICS.groupHeadingGapPx }}>
        <Text style={styles.helpLine}>{props.stateLabel}</Text>
        <Icon name="caret-right" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
    </View>;
}

function ShareSheetList(props: React.ComponentProps<ShareSheetHost['List']>) {
    // Private candidate rows and action closures must not enter the list's process-wide default cache.
    const [dynamicSectionCache] = React.useState(createDefaultDynamicSectionCache);
    return <SelectionList {...props} dynamicSectionCache={dynamicSectionCache} />;
}
function ConnectedPeoplePrompt(props: React.ComponentProps<ShareSheetHost['ConnectedPeoplePrompt']>) {
    const router = useRouter();
    return <SurfaceStateCard testID={props.testID} kind="empty" size="line" title={props.title}
        action={{ label: props.actionLabel, testID: `${props.testID}-find-friends`, onPress: () => router.push('/friends') }} />;
}
export const SHARE_SHEET_HOST: ShareSheetHost = {
    usePresentation() { return { host: useSharePresentationHost(), phone: useDeviceType() === 'phone', writeClipboard: useClipboardWrite() }; },
    useSharePresentation: useSharePresentationHost,
    useGrantRowPresentation: useShareGrantRowPresentation,
    text: key => t(key),
    suggestions: kind => t('shareSheet.suggestions', { kind }),
    noMatchingPeople: query => t('shareSheet.noMatchingPeople', { query }),
    PrincipalVisual: SharePrincipalVisual,
    Icon: props => props.name === 'info' ? <ShareHelpIcon /> : props.name === 'users' ? <ShareDirectoryIcon />
        : props.name === 'plus' ? <ShareAddIcon /> : <ShareHandoffIcon name={props.name} />,
    SecondaryText: props => <Text style={styles.helpLine}>{props.children}</Text>,
    Description: props => <Text variant="body" style={styles.description}>{props.children}</Text>,
    PublicLinkState: SharePublicLinkState,
    Button: ShareSheetButton,
    List: ShareSheetList,
    ConnectedPeoplePrompt,
    copyLinkFailed: () => Modal.alert(t('common.error'), t('shareSheet.copyLinkFailed')),
    applicationBaseUrl: resolvePublicShareApplicationBaseUrl,
    announce: announceAccessibilityMessage,
    announceRemoval: principal => announceAccessibilityMessage(t('shareSheet.removedAnnouncement', { name: principal.displayName })),
};
