import * as React from 'react';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useUnistyles } from 'react-native-unistyles';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import type { SessionChooserPageRequest } from '@/components/sessions/selection/readSessionChooserPage';
import { readSessionChooserFromCaptureWindow, type SessionChooserTarget } from '@/components/sessions/selection/sessionChooserSource';
import {
    openNativeCapturePermissionSettings,
    openRecentCapture,
    type NativeCaptureResult,
    type NativeCaptureSessionTarget,
    type NativeCaptureWindowDisplay,
    type NativeRecentCaptureEntry,
} from '@/desktop/capture/nativeCapture';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';
import { setDesktopWindowTitle } from '@/utils/platform/desktopWindowBridge';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { executeDesktopWindowActionWithResult, requestCaptureOpenSession, requestCaptureOpenSettings,
    type DesktopWindowActionResult, type DesktopWindowActionWaitOptions } from '@/utils/platform/desktopWindowActionBridge';

import { resolveCaptureDeliveryOutcome } from './captureDeliveryOutcome';
import { CaptureWindowScreen, type CaptureDelivery, type CaptureDeliveryOutcome, type CaptureWindowCaption, type CaptureWindowMeasure,
    type CaptureWindowNoteChips } from './CaptureWindowScreen';
import type { CaptureWindowMoreActions } from './CaptureWindowMoreMenu';
import { CaptureWindowTextChip } from './CaptureWindowTextChip';
import { createCaptureWindowPlacement } from './captureWindowPlacement';
import { captureWindowTitle } from './captureWindowTitle';
import { resolveCaptureWindowFrame, type CaptureRect } from './resolveCaptureWindowFrame';
import { resolveCaptureWindowTextView } from './captureWindowTextView';
import { useCaptureWindowActions } from './useCaptureWindowActions';
import type { CaptureWindowCapture } from './useCaptureWindowCapture';
import type { CaptureWindowText } from './useCaptureWindowText';
import { useDismissOnNextInput } from './useDismissOnNextInput';
import type { ImageAnnotator } from '@/components/ui/media/annotation/annotatorStore';
import { copyCaptureFromUi } from './copyCaptureFromUi';

export const translateCaptureRect = <T extends Readonly<{ x: number; y: number }>>(rect: T, by: Readonly<{ x: number; y: number }>): T =>
    ({ ...rect, x: rect.x - by.x, y: rect.y - by.y });
export const workAreaOf = (display: NativeCaptureWindowDisplay): CaptureRect => ({
    ...display.frame, y: display.frame.y + display.safeAreaTop, height: display.frame.height - display.safeAreaTop,
});

export function openRecentInCaptureWindow(entry: NativeRecentCaptureEntry, targetSession?: NativeCaptureSessionTarget | null,
    options?: DesktopWindowActionWaitOptions): Promise<DesktopWindowActionResult> {
    return openRecentCapture(entry.path).then(({ captureRef }) => executeDesktopWindowActionWithResult({
        windowLabel: 'capture', actionIdentifier: 'screenCapture.open',
        data: { captureRef, ...(targetSession ? { targetSession } : {}) },
    }, options));
}

export type CaptureEditorPreparation = Readonly<{ ok: true; note: string }> | Readonly<{ ok: false; cause: string }>;
type CaptureEditorTarget = Readonly<{ kind: 'session'; session: SessionChooserTarget }> | Readonly<{ kind: 'newSession' }>;

/** What a kind of capture brings to the one Capture window: a picture and its marks, or a video and its timeline. */
export type CaptureEditorMedia = Readonly<{
    annotator: ImageAnnotator;
    picture: Readonly<{ width: number; height: number }>;
    pictureUri?: string;
    renderPicture?: () => React.ReactNode;
    canvasHidden?: boolean;
    belowPicture?: React.ReactNode;
    notice?: React.ReactNode;
    noteChips?: CaptureWindowNoteChips;
    discardedTitle?: string;
    caption: CaptureWindowCaption;
    text: CaptureWindowText;
    note: string;
    onNoteChange: (note: string) => void;
    hasWork: boolean;
    thumbnailUri: string | null;
    /** Runs before any delivery; the text it returns is the message's note. */
    prepare: () => Promise<CaptureEditorPreparation>;
    /** Commit current marks before the admitted copy owner reads its native reference. */
    prepareCopy: () => Promise<void | ActionExecuteFailure>;
    copyFrameAtMs?: number;
    more?: Pick<CaptureWindowMoreActions, 'onResetTrim'>;
}>;

/** Everything the two kinds share: placement, target, delivery, discard and the window's actions. */
export function CaptureEditorShell(props: Readonly<{
    held: CaptureWindowCapture;
    capture: NativeCaptureResult;
    media: CaptureEditorMedia;
    display: NativeCaptureWindowDisplay;
    onClose: () => void;
}>) {
    const { theme } = useUnistyles();
    const { held, display, capture, media } = props;
    const { picture, text } = media;
    const [placement] = React.useState(createCaptureWindowPlacement);
    const [placementContext, setPlacementContext] = React.useState<Readonly<{ previousFrame: CaptureRect | null }> | null>(null);
    const signal = held.signal ?? undefined;
    const actions = useCaptureWindowActions(signal);
    const [target, setTarget] = React.useState<CaptureEditorTarget | null>(null);
    // A choice in this window makes the target this person's own, so the remembered-pick cue goes.
    const [chose, setChose] = React.useState(false);
    const [measure, setMeasure] = React.useState<CaptureWindowMeasure | null>(null);
    const [surface, setSurface] = React.useState<CaptureRect | null>(null);
    const discarded = React.useRef(false);
    const presented = React.useRef<AbortSignal | undefined>(undefined);
    const retryFromPreparation = React.useRef<CaptureDelivery | null>(null);

    const pinned = held.targetSession;
    const nativeTitle = captureWindowTitle(capture);
    React.useEffect(() => {
        fireAndForget(setDesktopWindowTitle(nativeTitle), { tag: 'CaptureWindow.title' });
    }, [nativeTitle]);
    React.useEffect(() => {
        let current = true;
        void placement.readPreviousFrame().then(context => { if (current) setPlacementContext(context); }).catch(() => {
            if (current) setPlacementContext({ previousFrame: null });
        });
        return () => { current = false; };
    }, [placement]);
    React.useEffect(() => {
        if (!pinned) return;
        // Read on show and whenever the target changes; nothing is pushed to this window (F3).
        void readSessionChooserFromCaptureWindow({ kind: 'target', targetSession: pinned }, { signal })
            .then(next => { if (!signal?.aborted) setTarget(current => current?.kind === 'newSession' ? current : { kind: 'session', session: next }); }).catch(() => undefined);
    }, [pinned, signal]);
    // The native capture holds the pin; a choice moves it there, and the read above follows.
    const chooseSession = async (address: SessionAddress) => {
        setChose(true);
        const chosen = await readSessionChooserFromCaptureWindow({ kind: 'target', targetSession: address }, { signal });
        if (signal?.aborted) return;
        setTarget({ kind: 'session', session: chosen });
        if (chosen.accountId) await executeDesktopWindowActionWithResult({ windowLabel: 'capture', intent: 'chooseSession', actionIdentifier: 'screenCapture.open',
            data: { captureRef: capture.captureRef, targetSession: { ...address, accountId: chosen.accountId } } }, { signal });
    };
    const readPage = React.useCallback((request: SessionChooserPageRequest) =>
        readSessionChooserFromCaptureWindow({ kind: 'page', ...request }, { signal }), [signal]);
    const textView = resolveCaptureWindowTextView({ disclosure: text.disclosure, read: text.read, appName: capture.source?.appName ?? null });
    useDismissOnNextInput(text.disclosure.showBlurCallout, text.onInput);

    const area = React.useMemo<CaptureRect | null>(() => capture.origin
        ? { ...capture.origin.rect, x: display.frame.x + capture.origin.rect.x, y: display.frame.y + capture.origin.rect.y }
        : null, [capture.origin, display.frame]);
    const workArea = React.useMemo(() => workAreaOf(display), [display]);
    const frame = React.useMemo(() => measure && placementContext ? resolveCaptureWindowFrame({
        picture, origin: area, workArea, remembered: placement.remembered,
        previousFrame: placementContext.previousFrame,
        metrics: { gutter: theme.space.s24, screenInset: theme.space.s24, ...measure },
    }) : null, [area, measure, picture, placement.remembered, placementContext, theme.space.s24, workArea]);

    // The native window appears at the union, already painted; only then does the paper start to grow (D3).
    React.useEffect(() => {
        if (!frame || signal?.aborted || (surface && presented.current === signal)) return;
        presented.current = signal;
        const next = surface ?? frame.union;
        void placement.present(next, signal).then(() => { if (!signal?.aborted) setSurface(next); });
    }, [frame, placement, signal, surface]);

    const sessionTarget = target?.kind === 'session' ? target.session : null;
    const row = sessionTarget?.row ?? null;
    const session = row?.label ?? '';
    const toOutcome = (delivery: CaptureDelivery, result: DesktopWindowActionResult | null): CaptureDeliveryOutcome => {
        return resolveCaptureDeliveryOutcome({ delivery, newSession: target?.kind === 'newSession', session, detail: row?.place ?? '', result });
    };

    const deliver = async (delivery: CaptureDelivery): Promise<CaptureDeliveryOutcome> => {
        retryFromPreparation.current = delivery;
        let prepared: CaptureEditorPreparation;
        try { prepared = await media.prepare(); }
        catch { return { ok: false, phase: 'preparation', cause: t('screenCapture.window.flattenFailed') }; }
        if (signal?.aborted) return { ok: false, phase: 'preparation', cause: t('screenCapture.window.flattenFailed') };
        if (!prepared.ok) return { ok: false, phase: 'preparation', cause: prepared.cause };
        const { note } = prepared;
        if (target?.kind === 'newSession' && delivery === 'addToDraft') {
            retryFromPreparation.current = null;
            return toOutcome(delivery, await actions.newSession({ captureRef: capture.captureRef, ...(note ? { note } : {}) }));
        }
        if (!pinned) return { ok: false, phase: 'delivery', cause: t('screenCapture.window.chooseSession') };
        const input = { captureRef: capture.captureRef, session: pinned, ...(note ? { note } : {}) };
        retryFromPreparation.current = null;
        return toOutcome(delivery, await (delivery === 'send' ? actions.send(input) : actions.addToDraft(input)));
    };

    const toSurface = surface ?? { x: 0, y: 0 };
    return (
        <CaptureWindowScreen
            signal={signal}
            frame={frame && surface ? {
                ...frame,
                window: translateCaptureRect(frame.window, toSurface),
                union: translateCaptureRect(frame.union, toSurface),
            } : null}
            area={area ? translateCaptureRect(area, toSurface) : null}
            workArea={translateCaptureRect(workArea, toSurface)}
            screenInset={theme.space.s24}
            onMeasure={setMeasure}
            onOpenStart={held.onOpenStart}
            annotator={media.annotator}
            {...(media.pictureUri ? { pictureUri: media.pictureUri } : {})}
            {...(media.renderPicture ? { renderPicture: media.renderPicture } : {})}
            canvasHidden={media.canvasHidden}
            belowPicture={media.belowPicture}
            notice={media.notice}
            noteChips={media.noteChips}
            discardedTitle={media.discardedTitle}
            caption={media.caption}
            target={target?.kind === 'newSession' ? { kind: 'newSession', title: t('transcript.selection.sendTo.newSession'), machineName: '', mark: null } : row ? {
                title: row.label,
                machineName: row.machineName ?? row.subtitle,
                disabledReason: row.disabledReason,
                ...(held.defaultReason === 'lastCapturePick' && !chose ? { cue: t('screenCapture.window.sameAsLastCapture') } : {}),
                mark: <SessionAgentCatalogIdentityIcon agentId={row.agentId} machineId={row.machineId} serverId={row.address.serverId} size={14} color={theme.colors.composer.chipTint} />,
            } : null}
            chooser={{
                readPage,
                selected: sessionTarget?.address ?? null,
                onSelect: (address) => void chooseSession(address),
                canStartSession: true,
                onNewSession: () => { setChose(true); setTarget({ kind: 'newSession' }); },
                newSessionContext: row?.place ?? null,
            }}
            sendIncludesDraftText={sessionTarget?.hasDraftText === true}
            unreachable={sessionTarget?.machineReachability === 'unreachable' && row ? { machineName: row.machineName ?? row.subtitle, lastSeen: null } : null}
            renderWindowText={capture.source ? (surface) => (
                <CaptureWindowTextChip
                    view={textView}
                    onToggle={() => text.setIncluded(!text.disclosure.included)}
                    surface={surface}
                    onResolveBlurWarning={text.resolveWarning}
                    onOpenPermissionSettings={() => {
                        void text.requestPermission();
                        void openNativeCapturePermissionSettings('window_text');
                    }}
                    onDeclinePermission={() => text.setIncluded(false)}
                />
            ) : undefined}
            note={media.note}
            onNoteChange={media.onNoteChange}
            onDeliver={deliver}
            onRetry={async (delivery) => retryFromPreparation.current === delivery
                ? deliver(delivery) : toOutcome(delivery, await actions.retry())}
            thumbnailUri={media.thumbnailUri}
            hasWork={media.hasWork}
            onDiscard={() => { discarded.current = true; }}
            onUndoDiscard={() => { discarded.current = false; }}
            onBeforeClose={async () => {
                if (!discarded.current) return;
                const result = await actions.discard(capture.captureRef);
                if (!result.ok) return { ok: false, cause: result.error ?? result.errorCode ?? t('common.error') };
            }}
            onClosed={() => {
                props.onClose();
                void placement.hide();
            }}
            onOpenSession={pinned ? () => { void requestCaptureOpenSession(pinned, { signal }); } : undefined}
            onCopy={async () => (await copyCaptureFromUi({ captureRef: capture.captureRef,
                ...(media.copyFrameAtMs === undefined ? {} : { frameAtMs: media.copyFrameAtMs }) }, media.prepareCopy)).ok}
            onShowInFolder={() => void actions.showInFolder(capture.captureRef)}
            more={{
                ...(textView.preview ? { onCopyWindowText: () => { void copyCaptureFromUi({ captureRef: capture.captureRef, content: 'windowText' }); } } : {}),
                onOpenSettings: () => void requestCaptureOpenSettings({ signal }),
                ...media.more,
            }}
            onOpenRecent={(entry) => openRecentInCaptureWindow(entry, pinned, { signal })}
            onSurfaceRect={(rect, glassRadius) => {
                const next = { ...rect, x: rect.x + toSurface.x, y: rect.y + toSurface.y };
                void placement.present(next, signal, glassRadius).then(() => { if (!signal?.aborted) setSurface(next); });
            }}
        />
    );
}
