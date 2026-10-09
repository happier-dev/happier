import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { SelectionList } from '@/components/ui/selectionList';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { createDefaultDynamicSectionCache } from '@/components/ui/selectionList/selectionListDynamicSectionCache';
import { resolvePublicShareApplicationBaseUrl } from '@/components/sessions/sharing/publicShareApplicationUrl';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { useDeviceType } from '@/utils/platform/responsive';
import { buildShareSheetSelectionStep, ShareHelp, ShareHandoffIcon, shareSheetStepId } from './buildShareSheetSelectionStep';
import type {
    ShareDirectoryKind,
    ShareGrantRowModel,
    ShareSheetActions,
    ShareSheetAdapter,
    ShareSheetModel,
    ShareSheetPresentation,
} from './shareSheetTypes';

const styles = StyleSheet.create(theme => ({
    full: { flex: 1, minHeight: 0 }, compact: { minHeight: 0 },
    footer: { paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx, paddingVertical: PAGE_LIST_METRICS.groupHeadingGapPx,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.subtle,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: PAGE_LIST_METRICS.groupHeadingGapPx },
    handoffs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', flexShrink: 1, gap: PAGE_LIST_METRICS.groupHeadingGapPx },
    action: { flexGrow: 0 },
}));
const noop = () => {};

export type ShareSheetProps<TRow extends ShareGrantRowModel> = Readonly<{
    model: ShareSheetModel<TRow>;
    actions: ShareSheetActions;
    adapter: ShareSheetAdapter<TRow>;
    presentation: ShareSheetPresentation;
    onRequestClose?: () => void;
    /** A host's explicit navigation intent opens a row without replacing the sheet or its state. */
    openRowRequest?: Readonly<{ key: string }>;
    testID: string;
}>;

/**
 * The one share sheet. Sessions, workflows, roles and launch profiles all mount it with their own
 * adapter; there is no second sheet. It owns the list, which grant is open, the browsed directory,
 * removal focus and Copy link.
 */
export function ShareSheet<TRow extends ShareGrantRowModel>(props: ShareSheetProps<TRow>): React.ReactElement {
    const { model, actions, adapter, presentation, onRequestClose, testID } = props;
    const footerButtonSize = useDeviceType() === 'phone' ? 'normal' : 'small';
    const [expanded, setExpanded] = React.useState<string | null>(props.openRowRequest?.key ?? null);
    React.useEffect(() => {
        if (props.openRowRequest) setExpanded(props.openRowRequest.key);
    }, [props.openRowRequest]);
    const [directoryKind, setDirectoryKind] = React.useState<ShareDirectoryKind | undefined>();
    const [copiedPath, setCopiedPath] = React.useState<string | null>(null);
    // Private candidate rows and action closures must not enter the primitive's process-wide default cache.
    const [dynamicSectionCache] = React.useState(createDefaultDynamicSectionCache);
    // An acknowledged removal deletes the row the selection anchor points at. Selection moves to the
    // next remaining grant, then the previous one, then the search field. A republished or failed
    // row is still present, so it is left alone.
    const acknowledgedGrants = React.useRef(model.grants);
    React.useEffect(() => {
        const previous = acknowledgedGrants.current;
        acknowledgedGrants.current = model.grants;
        if (previous === model.grants || expanded === null) return;
        const removedIndex = previous.findIndex((row) => row.principal.key === expanded);
        if (removedIndex < 0) return;
        const retained = new Set(model.grants.map((row) => row.principal.key));
        if (retained.has(expanded)) return;
        const next = previous.slice(removedIndex + 1).find((row) => retained.has(row.principal.key));
        const before = previous.slice(0, removedIndex).reverse().find((row) => retained.has(row.principal.key));
        setExpanded(next?.principal.key ?? before?.principal.key ?? null);
        announceAccessibilityMessage(t('shareSheet.removedAnnouncement', { name: previous[removedIndex]!.principal.displayName }));
    }, [expanded, model.grants]);

    const linkPath = adapter.linkPath;
    const copyLink = linkPath ? {
        copied: copiedPath === linkPath,
        onCopy: () => {
            void (async () => {
                const copied = await setClipboardStringSafe(`${resolvePublicShareApplicationBaseUrl()}${linkPath}`);
                if (!copied) {
                    Modal.alert(t('common.error'), t('shareSheet.copyLinkFailed'));
                    return;
                }
                setCopiedPath(linkPath);
                announceAccessibilityMessage(t('shareSheet.linkCopied'));
            })();
        },
    } : undefined;
    const idPrefix = testID === `${adapter.namespace}-editor` ? '' : `${testID}:`;
    const input = { model, actions, adapter, presentation, onExpand: setExpanded, idPrefix, ...(copyLink ? { copyLink } : {}) };
    const rootStep = buildShareSheetSelectionStep(input);
    const source = directoryKind && model.directory.sections.find((section) => section.kind === directoryKind);
    const activeStep = directoryKind ? buildShareSheetSelectionStep({ ...input, directoryKind }) : null;
    return <View testID={testID} style={presentation === 'full' ? styles.full : styles.compact}>
        <SelectionList rootStep={rootStep} syncActiveStep={activeStep ?? undefined}
            onActiveStepChange={(step) => {
                setDirectoryKind(model.directory.sections.find((section) => step.id === shareSheetStepId(adapter.namespace, section.kind))?.kind);
            }}
            inputValue={model.directory.query} onChangeInputValue={actions.setQuery}
            selectedOptionId={expanded} onSelect={noop} onRequestClose={onRequestClose ?? noop}
            optionsHostInlineControls dynamicSectionCache={dynamicSectionCache}
            listAccessibilityLabel={adapter.title} testID={`${testID}:list`}
            inputTestID={idPrefix ? `${testID}:${adapter.namespace}-search` : `${adapter.namespace}-search`}
            autoFocusInputOnWeb={presentation === 'compact'} autoFocusInputOnNative={false}
            surface={presentation === 'inline' ? 'none' : undefined}
            bodyFooter={presentation !== 'compact' && !directoryKind ? <ShareHelp adapter={adapter} testID={`${idPrefix}${adapter.namespace}-help`} /> : undefined}
            fillAvailableSpace={presentation === 'full'} heightBehavior={presentation === 'compact' ? 'stabilizedContentHeight' : 'content'}
            pagination={source ? { hasMore: source.hasMore, loadingMore: source.loadingMore, requestKey: source.cursor,
                error: source.error?.message, onEndReached: () => actions.loadMore(source.kind), onRetry: () => actions.retryDirectory(source.kind),
                loadingLabel: t('common.loading'), moreLabel: t('shareSheet.browseAll'), retryLabel: t('common.retry'),
                endReachedLabel: t('shareSheet.allLoaded') } : undefined} />
        {presentation === 'full' && (copyLink || adapter.sendCopy || onRequestClose) ? <View style={styles.footer}>
            <View style={styles.handoffs}>
                {copyLink ? <RoundButton size={footerButtonSize} display="inverted" style={styles.action}
                    testID={`${idPrefix}${adapter.namespace}-copy-link`}
                    title={t(copyLink.copied ? 'shareSheet.linkCopied' : 'shareSheet.copyLink')}
                    leading={<ShareHandoffIcon name="link" />} onPress={copyLink.onCopy} /> : null}
                {adapter.sendCopy ? <RoundButton size={footerButtonSize} display="inverted" style={styles.action}
                    testID={`${idPrefix}${adapter.namespace}-send-copy`} title={t('shareSheet.sendCopy')}
                    leading={<ShareHandoffIcon name="copy" />} onPress={adapter.sendCopy} /> : null}
            </View>
            {onRequestClose ? <RoundButton size={footerButtonSize} style={styles.action} testID={`${idPrefix}${adapter.namespace}-done`}
                title={t('common.done')} onPress={onRequestClose} /> : null}
        </View> : null}
    </View>;
}
