import * as React from 'react';
import { HappierShareSheet } from '../presentation/sharing/ShareSheet.js';
import { buildShareSheetSelectionStep, ShareHelp, shareSheetStepId } from './buildShareSheetSelectionStep.js';
import { useShareSheetHost } from './useShareSheetHost.js';
import type { ShareSheetHost } from './shareSheetHost.js';
import type { ShareDirectoryKind, ShareGrantRowModel, ShareSheetActions, ShareSheetModel } from './shareGrantModels.js';
import type { ShareSheetAdapter, ShareSheetPresentation } from './shareSheetModels.js';
const noop = () => {};
export type ShareSheetProps<TRow extends ShareGrantRowModel> = Readonly<{
    host?: ShareSheetHost;
    model: ShareSheetModel<TRow>;
    actions: ShareSheetActions;
    adapter: ShareSheetAdapter<TRow>;
    presentation: ShareSheetPresentation;
    onRequestClose?: () => void;
    /** Reviewed flows replace Done with their commit action in the one primary slot. */
    primaryAction?: NonNullable<React.ComponentProps<typeof HappierShareSheet>['done']> & Readonly<{ loading?: boolean }>;
    /** A host's explicit navigation intent opens a row without replacing the sheet or its state. */
    openRowRequest?: Readonly<{ key: string }>;
    testID: string;
    /**
     * A floating host's bound for the sheet's list. The list owns its own scroll (SelectionList contract), so a
     * popover passes its height here and keeps its own surface unscrolled instead of nesting a second scroller.
     */
    maxHeight?: number;
}>;

/**
 * The one share sheet. Sessions, workflows, roles and launch profiles all mount it with their own
 * adapter; there is no second sheet. It owns the list, which grant is open, the browsed directory,
 * removal focus and Copy link.
 */
export function ShareSheet<TRow extends ShareGrantRowModel>(props: ShareSheetProps<TRow>): React.ReactElement {
    const { model, actions, adapter, presentation, onRequestClose, testID } = props;
    const host = useShareSheetHost(props.host);
    const { writeClipboard, phone, host: presentationHost } = host.usePresentation();
    const [expanded, setExpanded] = React.useState<string | null>(props.openRowRequest?.key ?? null);
    React.useEffect(() => {
        if (props.openRowRequest) setExpanded(props.openRowRequest.key);
    }, [props.openRowRequest]);
    const [directoryKind, setDirectoryKind] = React.useState<ShareDirectoryKind | undefined>();
    const [copiedPath, setCopiedPath] = React.useState<string | null>(null);
    // Suggestions appear once someone starts adding and stay for the sheet's life: hiding them again on
    // blur would pull a row out from under the click that blurred the field. A compact popover is the
    // add flow itself, so it always lists them.
    const [addingStarted, setAddingStarted] = React.useState(false);
    const revealSuggestions = presentation === 'compact' || addingStarted || model.directory.query.trim().length > 0;
    // Removing a row deletes the selection anchor. Selection moves to the
    // next remaining grant, then the previous one, then the search field. A republished or failed
    // row is still present, so it is left alone.
    const previousGrants = React.useRef(model.grants);
    React.useEffect(() => {
        const previous = previousGrants.current;
        previousGrants.current = model.grants;
        if (previous === model.grants || expanded === null) return;
        const removedIndex = previous.findIndex((row) => row.principal.key === expanded);
        if (removedIndex < 0) return;
        const retained = new Set(model.grants.map((row) => row.principal.key));
        if (retained.has(expanded)) return;
        const next = previous.slice(removedIndex + 1).find((row) => retained.has(row.principal.key));
        const before = previous.slice(0, removedIndex).reverse().find((row) => retained.has(row.principal.key));
        setExpanded(next?.principal.key ?? before?.principal.key ?? null);
        if (!model.draft) host.announceRemoval(previous[removedIndex]!.principal);
    }, [expanded, model.draft, model.grants]);

    const linkPath = adapter.linkPath;
    const copyLink = linkPath ? {
        copied: copiedPath === linkPath,
        onCopy: () => {
            void (async () => {
                const copied = await writeClipboard(`${host.applicationBaseUrl()}${linkPath}`);
                if (!copied) {
                    host.copyLinkFailed();
                    return;
                }
                setCopiedPath(linkPath);
                host.announce(host.text('shareSheet.linkCopied'));
            })();
        },
    } : undefined;
    const idPrefix = testID === `${adapter.namespace}-editor` ? '' : `${testID}:`;
    const input = { host, model, actions, adapter, presentation, onExpand: setExpanded, expandedKey: expanded, idPrefix, revealSuggestions,
        ...(copyLink ? { copyLink } : {}) };
    const rootStep = buildShareSheetSelectionStep(input);
    const source = directoryKind && model.directory.sections.find((section) => section.kind === directoryKind);
    const activeStep = directoryKind ? buildShareSheetSelectionStep({ ...input, directoryKind }) : null;
    return <HappierShareSheet testID={testID} presentation={presentation} phone={phone} host={presentationHost} Button={host.Button}
        handoffs={[
            ...(copyLink ? [{ testID: `${idPrefix}${adapter.namespace}-copy-link`, label: host.text(copyLink.copied ? 'shareSheet.linkCopied' : 'shareSheet.copyLink'),
                leading: <host.Icon name="link" />, onPress: copyLink.onCopy }] : []),
            ...(adapter.sendCopy ? [{ testID: `${idPrefix}${adapter.namespace}-send-copy`, label: host.text('shareSheet.sendCopy'),
                leading: <host.Icon name="copy" />, onPress: adapter.sendCopy }] : []),
        ]}
        note={presentation === 'full' ? adapter.footnote : undefined}
        done={props.primaryAction ?? (onRequestClose ? { testID: `${idPrefix}${adapter.namespace}-done`, label: host.text('common.done'), onPress: onRequestClose } : undefined)}>
        {adapter.description ? <host.Description>{adapter.description}</host.Description> : null}
        <host.List rootStep={rootStep} syncActiveStep={activeStep ?? undefined}
            onActiveStepChange={(step) => {
                setDirectoryKind(model.directory.sections.find((section) => step.id === shareSheetStepId(adapter.namespace, section.kind))?.kind);
            }}
            inputValue={model.directory.query} onChangeInputValue={actions.setQuery}
            onInputFocus={() => setAddingStarted(true)}
            selectedOptionId={expanded} onSelect={noop} onRequestClose={onRequestClose ?? noop}
            optionsHostInlineControls
            selectionMark="none"
            listAccessibilityLabel={adapter.title} testID={`${testID}:list`}
            inputTestID={idPrefix ? `${testID}:${adapter.namespace}-search` : `${adapter.namespace}-search`}
            autoFocusInputOnWeb={presentation === 'compact'} autoFocusInputOnNative={false}
            surface={presentation === 'inline' ? 'none' : undefined}
            bodyFooter={presentation === 'inline' && !directoryKind ? <ShareHelp host={host} adapter={adapter} testID={`${idPrefix}${adapter.namespace}-help`} /> : undefined}
            fillAvailableSpace={presentation === 'full'}
            {...(props.maxHeight === undefined ? { heightBehavior: presentation === 'full' ? 'content' as const : 'stabilizedContentHeight' as const }
                : { maxHeight: props.maxHeight, heightBehavior: 'fixedToMaxHeight' as const })}
            pagination={source ? { hasMore: source.hasMore, loadingMore: source.loadingMore, requestKey: source.cursor,
                error: source.error?.message, onEndReached: () => actions.loadMore(source.kind), onRetry: () => actions.retryDirectory(source.kind),
                loadingLabel: host.text('common.loading'), moreLabel: host.text('shareSheet.browseAll'), retryLabel: host.text('common.retry'),
                endReachedLabel: source.candidates.length === 0 ? '' : host.text('shareSheet.allLoaded') } : undefined} />
    </HappierShareSheet>;
}
