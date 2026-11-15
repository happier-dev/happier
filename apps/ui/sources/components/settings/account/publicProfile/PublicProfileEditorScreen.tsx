import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import type {
  HappierPublicProfileHeroGeometry,
} from '@happier-dev/plugin-ui/presentation';
import {
  PUBLIC_PROFILE_FIELDS_V1,
  type PublicProfileField,
  type PublicProfilePolicyV1,
} from '@happier-dev/protocol/account/publicProfile';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { createPublicProfileProjector, projectPublicProfilePreview } from '@happier-dev/protocol/account/projectPublicProfile';
import { PublicProfilePreviewResultV1Schema, type PublicProfilePreparationUnavailableReasonV1,
  type PublicProfileUpdateIntentV1 } from '@happier-dev/protocol/account/publicProfileIntents';
import type {
  PublicProfileAppearanceV1,
  PublicProfileContextV1,
  PublicProfileLocalPreviewViewV1,
  PublicProfileOwnerRecordV1,
  PublicProfilePreparedAppearanceV1,
} from '@happier-dev/protocol/account/publicProfilePublication';
import type { PublicProfilePreviewAdmission } from '@happier-dev/protocol/actions/executor/publicProfileActions';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { BuiltinUsagePublicPresentationV1 } from '@happier-dev/protocol/widgets';

import { AtmospherePreview, PublicPictureBand } from '@/components/atmosphere/look/AtmospherePreview';
import { pictureCreditLine } from '@/components/atmosphere/look/pictureCredit';
import { usePublicProfileAtmospherePreviewValue } from '@/sync/store/settingsPreview';
import { useAtmospherePictureCatalog } from '@/components/atmosphere/useAtmospherePictureCatalog';
import { LookPopover } from '@/components/atmosphere/look/LookChip';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import {
  formatUsageCalendarPeriod,
} from '@/sync/domains/usage/usageCalendarPresentation';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { useAccountEncryptionMode } from '../useAccountEncryptionMode';
import {
  PublicProfileEditor,
  type PublicProfileEditorView,
} from './PublicProfileEditor';
import {
  PublicProfileLookPanel,
  usePreparePublicProfileLook,
} from './PublicProfileLookPanel';
import { PublicProfileConsentStatus } from './PublicProfileConsentStatus';
import { PublicProfileDetailsPanel } from './PublicProfileDetailsPanel';
import { PublicProfileHiddenBlockNote } from './PublicProfileHiddenBlockNote';
import { publicProfileFigureControls } from './PublicProfileFigureEye';
import { PublicProfilePublicData } from './PublicProfilePublicData';
import { PublicProfileReview } from './PublicProfileReview';
import { prepareAppliedProfileAppearance, preparedPictureCopy, useAppliedPictureCopy } from './publicPictureCopy';
import {
  createPublicProfileDraft,
  draftLookPresentation,
  draftPreviewMetadata,
  draftVisitorTheme,
  publicProfileDraftQuery,
  publicProfileRecordPeriod,
  setPublicProfileDraftTheme,
  resolvePublicFieldPlacements,
  resolvePublicProfileDraftChanges,
  type PublicProfileDraft,
  type PublicProfilePeriod,
} from './publicProfileDraft';
import { publicProfileMutationNotice, settlePublicProfileMutation } from './publicProfileMutation';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';
import { usePublicProfileWidgetArea } from './usePublicProfileWidgetArea';
import { PublicProfileWidgetArea, publicProfilePresetNames, usePublicProfileUsageContext } from './PublicProfileWidgetArea';
import { usePublicProfileConsent } from './usePublicProfileConsent';
import { publicProfileLinkLabel, publicProfilePageLabels, usePublicProfileUsageHost } from './publicProfilePresentation';
import { openUsageRecapComposer } from '@/components/settings/usage/widgets/recap/UsageRecapComposer';
import { useCurrentUiContextCommandBridge } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { PublishRiseBand } from './publicProfilePublishRise';
import { PublicProfileWidgetPreviewProvider, type PublicProfileWidgetPreview } from './PublicProfileWidgetSurface';

/** The owner's own values for every item: computed locally, never uploaded or published. */
const OWNER_POLICY: PublicProfilePolicyV1 = {
  indexable: false,
  fields: Object.fromEntries(
    PUBLIC_PROFILE_FIELDS_V1.map((field) => [field, true]),
  ) as PublicProfilePolicyV1['fields'],
};
const BLOCK_TITLE_KEYS = {
  usage_period_summary: 'totals',
  usage_parallel: 'parallel',
  usage_rhythm: 'sky',
  usage_breakdowns: 'crew',
  usage_planet: 'planet',
  usage_orbit: 'orbit',
  usage_outcomes: 'shipped',
} as const;

function blockTitle(
  presentation: BuiltinUsagePublicPresentationV1,
): string | undefined {
  // Rhythm's hour forms are their own blocks: Night owl's "When agents work" and "Week tide".
  const key = presentation.widgetId === 'usage_rhythm' && presentation.inputs.style === 'weekdayHour' ? 'hours'
    : presentation.widgetId === 'usage_rhythm' && presentation.inputs.style === 'weekTide' ? 'tide'
      : BLOCK_TITLE_KEYS[presentation.widgetId as keyof typeof BLOCK_TITLE_KEYS];
  return key ? t(`publicIdentity.blocks.${key}`) : undefined;
}

function blockIds(view: PublicProfileEditorView | null): ReadonlySet<string> {
  return new Set(
    view?.layout.items.flatMap((item) =>
      item.kind === 'widget'
        ? [item.id]
        : item.children.map((child) => child.id),
    ) ?? [],
  );
}

/**
 * What the preview needs to compile the page. The band is drawn locally from the draft, so a picture
 * is prepared only at review time; the preview itself never carries pixels.
 */
function previewAppearance(
  draft: PublicProfileDraft,
  applied: PublicProfilePreparedAppearanceV1 | null,
): PublicProfilePreparedAppearanceV1 {
  if (draft.appearance.kind === 'applied') {
    const base = applied ?? { atmosphere: { source: 'none' }, theme: 'auto' };
    return draft.appearance.theme ? { ...base, theme: draft.appearance.theme } : base;
  }
  const atmosphere = draft.appearance.atmosphere;
  return {
    theme: draft.appearance.theme,
    atmosphere:
      atmosphere.source === 'planet'
        ? { source: 'planet', planet: atmosphere.planet }
        : { source: 'none' },
  };
}

/**
 * Settings → Account → Public profile → Edit: the owner's page with Edit and Preview, Public data,
 * Look, a reviewed first Publish and direct Apply. Published consent has its own acknowledged update.
 */
export function PublicProfileEditorScreen(): React.ReactElement {
  const scope = useAccountSettingsScope();
  return <CapturedPublicProfileEditorScreen key={JSON.stringify(scope)} scope={scope} />;
}

/** Private snapshot, consent and Look memory belong to the captured publishing Account. */
function CapturedPublicProfileEditorScreen({ scope }: Readonly<{ scope: ReturnType<typeof useAccountSettingsScope> }>): React.ReactElement {
  const RecapCommandBridge = useCurrentUiContextCommandBridge();
  const execution = useMountedActionExecution(scope);
  const serverId = scope?.serverId ?? '';
  const { state, reload, acknowledge } = usePublicProfileOwnerRead(execution, scope);
  const read = state.kind === 'ready' ? state.read : null;
  const record = read?.kind === 'ready' ? read.record : null;
  const context = read?.context ?? null;
  const encryption = useAccountEncryptionMode();
  const { width } = useWindowDimensions();
  const singleColumn = width < HAPPIER_PUBLIC_PROFILE_HERO_METRICS.singleColumnBelowWidthPx;
  const [privateDraft, setDraft] = React.useState<PublicProfileDraft | null>(null);
  // Placed widgets read the page's own public period, as visitors' numbers do.
  const areaPeriod = privateDraft?.period ?? createPublicProfileDraft(record, { layout: { v: 1, items: [] } }).period;
  const areaUsage = usePublicProfileUsageContext(areaPeriod);
  const presetNames = React.useMemo(publicProfilePresetNames, []);
  const widgetArea = usePublicProfileWidgetArea(serverId, execution, blockTitle, areaUsage.context, presetNames);
  const draft = React.useMemo(() => privateDraft && widgetArea.candidate
    ? { ...privateDraft, layout: widgetArea.candidate.layout } : privateDraft, [privateDraft, widgetArea.candidate?.layout]);
  const [mode, setMode] = React.useState<'edit' | 'preview'>('edit');
  // The local preview and the period it was prepared for, so the title never names a period its numbers don't cover.
  const [snapshotView, setSnapshotView] =
    React.useState<Readonly<{ view: PublicProfileLocalPreviewViewV1; period: PublicProfilePeriod }> | null>(null);
  // The outcome line: a failure or uncertainty is a warning; a completed Publish, Apply or Undo is a success.
  // A first Publish ends on its result: the page's link, with Copy link and Badge (lab ppflow-F2ok).
  const [noticeState, setNoticeState] = React.useState<Readonly<{ text: string; tone: 'success' | 'warning'; link?: string; copied?: boolean }> | null>(null);
  const setNotice = React.useCallback((text: string | null, tone: 'success' | 'warning' = 'warning') =>
    setNoticeState(text ? { text, tone } : null), []);
  const notice = noticeState?.text ?? null;
  const [publishMoment, setPublishMoment] = React.useState<number | null>(null);
  // The moment lives until its result line has entered; then Edit/Preview remounts show the settled page.
  const settlePublishMoment = React.useCallback(() => setPublishMoment(null), []);
  // Why the page's own Usage preview is missing: said once, on the page's period line.
  const [previewReason, setPreviewReason] = React.useState<PublicProfilePreparationUnavailableReasonV1 | null>(null);
  const [omittedPrivateProjectCount, setOmittedPrivateProjectCount] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);
  const [panel, setPanel] = React.useState<'look' | 'publicData' | 'details' | null>(null);
  const lookAnchor = React.useRef<View>(null);
  const dataAnchor = React.useRef<View>(null);
  const detailsAnchor = React.useRef<View>(null);
  // The edition an Apply replaced, kept on this device for its direct Undo.
  const [undoable, setUndoable] = React.useState<PublicProfileUpdateIntentV1 | null>(null);
  React.useEffect(() => {
    if (record?.state === 'published') return;
    // A local result belongs to the live publication, including when another Session withdraws it.
    setNoticeState(null);
    setPublishMoment(null);
    setUndoable(null);
  }, [record?.state]);
  const prepareLook = usePreparePublicProfileLook(serverId);
  const consent = usePublicProfileConsent({ record, draft, setDraft, execution, onAcknowledged: acknowledge });

  // Consent acknowledgements preserve private placement/Look edits. Only Apply reseeds the edition.
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!read || seeded.current) return;
    seeded.current = true;
    setDraft(
      createPublicProfileDraft(record, {
        layout: { v: 1, items: [] },
      }),
    );
  }, [read, record]);

  const query = publicProfileDraftQuery({ period: areaPeriod });
  const previewMetadata = React.useMemo(() => draft ? draftPreviewMetadata(draft, record) : {}, [draft?.metadata, record]);
  // The private draft owns its reviewed Look even after withdrawal deletes the public edition.
  const recordAppearance = draft?.appearance.kind === 'applied' ? draft.appearance.value : record?.appearance ?? null;
  const appliedPicture = recordAppearance?.atmosphere.source === 'picture' ? recordAppearance.atmosphere.picture : null;
  const appliedPictureData = useAppliedPictureCopy(
    appliedPicture && context?.urls?.page ? `${context.urls.page}/background` : null,
    appliedPicture?.ref.id ?? null,
  );
  const appliedAppearance = React.useMemo<PublicProfilePreparedAppearanceV1 | null>(() => {
    return prepareAppliedProfileAppearance(recordAppearance, appliedPictureData);
  }, [recordAppearance, appliedPictureData]);

  // One local preview with every item gives the owner's own values; visitors are projected from it.
  // The snapshot depends only on the period; blocks, consent and look are compiled locally from it,
  // so editing the page never re-reads Usage. The latest callbacks are read without restarting.
  const latest = React.useRef({ executeValue: execution.executeValue, draft, appliedAppearance });
  latest.current = { executeValue: execution.executeValue, draft, appliedAppearance };
  const { ready } = execution;
  const queryKey = JSON.stringify(query);
  const hasDraft = draft !== null;
  const [attempt, setAttempt] = React.useState(0);
  const previewAdmission = React.useRef<Readonly<{ queryKey: string; pending: Promise<PublicProfilePreviewAdmission | null> }> | null>(null);
  React.useEffect(() => {
    const { draft: seed } = latest.current;
    if (!ready || !hasDraft || !seed) return;
    let current = true;
    setPreviewReason(null);
    const pending = (async () => {
      let admitted: PublicProfilePreviewAdmission | null = null;
      try {
        const result = PublicProfilePreviewResultV1Schema.parse(
          await latest.current.executeValue('account.public_profile.preview', {
            policy: OWNER_POLICY,
            metadataSelection: {},
            query: JSON.parse(queryKey),
            // Facts are independent of placement; composing the private area never re-queries Usage.
            layout: { v: 1, items: [] },
            appearance: previewAppearance(seed, latest.current.appliedAppearance),
          }, { capturePublicProfilePreview: preview => { if (current) admitted = preview; } }),
        );
        if (!current) return null;
        if (result.kind === 'ready') {
          setSnapshotView({ view: result.view, period: JSON.parse(queryKey).period.relative });
          setOmittedPrivateProjectCount(result.omittedPrivateProjectCount ?? 0);
        }
        else setPreviewReason(result.reason);
        return admitted;
      } catch {
        if (current) setPreviewReason('preparation_unavailable');
        return null;
      }
    })();
    previewAdmission.current = { queryKey, pending };
    return () => {
      current = false;
      previewAdmission.current = null;
    };
  }, [ready, queryKey, hasDraft, attempt]);

  // Revocation never requires unlocked/fresh Usage: the acknowledged public snapshot is sufficient.
  const previewSnapshot = snapshotView?.view.snapshot ?? record?.snapshot ?? null;
  const previewPeriod = snapshotView?.period ?? publicProfileRecordPeriod(record);
  const projector = React.useMemo(() => previewSnapshot ? createPublicProfileProjector(previewSnapshot) : null, [previewSnapshot]);
  const ownerProjection = React.useMemo(() => context && projector ? projector.project({ context, metadata: previewMetadata, policy: OWNER_POLICY,
    relativePeriod: previewPeriod }) : null, [projector, context, previewMetadata, previewPeriod]);
  const visitorProjection = React.useMemo(() => context && projector && draft ? projector.project({ context, metadata: previewMetadata, policy: draft.policy,
    relativePeriod: previewPeriod }) : null, [projector, context, previewMetadata, draft?.policy, previewPeriod]);
  const views = React.useMemo(() => {
    if (!ownerProjection || !visitorProjection || !draft || !context || !previewSnapshot) return null;
    const owner = { ...ownerProjection.view, layout: ownerProjection.projectLayout(draft.layout) };
    const visitor = { ...visitorProjection.view, layout: visitorProjection.projectLayout(draft.layout) };
    const visible = blockIds(visitor);
    return {
      owner,
      visitor,
      hidden: new Set([...blockIds(owner)].filter((id) => !visible.has(id))),
      placements: resolvePublicFieldPlacements({
        context,
        snapshot: previewSnapshot,
        draft,
      }),
    };
  }, [ownerProjection, visitorProjection, draft?.layout, draft?.policy, context, previewSnapshot]);

  const changes = draft
    ? resolvePublicProfileDraftChanges(record, draft)
    : null;
  const changeCount = changes
    ? Number(changes.policy) +
      Number(changes.layout) +
      Number(changes.appearance) +
      Number(changes.metadata) +
      Number(changes.period)
    : 0;
  const usage = usePublicProfileUsageHost(
    serverId,
    previewSnapshot?.period ?? null,
  );
  const pictures = useAtmospherePictureCatalog();
  const lookPresentation = draft ? draftLookPresentation(draft) : null;
  const pictureRef = lookPresentation?.source === 'picture' ? lookPresentation.picture.ref : null;
  const creditPicture = pictureRef?.kind === 'builtin' ? pictures.find(picture => picture.id === pictureRef.id) : undefined;
  const credit = creditPicture ? pictureCreditLine(creditPicture) : null;
  const awaitingReason = previewReason ? t(`publicIdentity.profile.reasons.${previewReason}`) : t('publicIdentity.editor.preparing');
  // While preparing, the period line says so; a known reason is said by the unavailable line with its Retry instead.
  const pendingLine = previewReason ? undefined : t('publicIdentity.editor.preparing');
  const labels = React.useMemo(() => context ? publicProfilePageLabels(context, previewSnapshot, credit, previewPeriod, pendingLine) : null,
    [context, previewSnapshot, credit, previewPeriod, pendingLine]);
  // Until the page has its own preview, it is still this person's page: their name, handle and band.
  const shellView = React.useMemo(() => context?.handle ? {
    v: 1 as const, handle: context.handle, indexable: false, state: 'published' as const, identity: context.identity,
    metadata: {}, snapshot: null, layout: { v: 1 as const, items: [] }, urls: context.urls,
  } : null, [context]);
  // Read at press time, so the page's preview keeps its identity while consent state changes.
  const consentLatest = React.useRef(consent);
  consentLatest.current = consent;
  const shareField = React.useCallback((field: PublicProfileField) => { void consentLatest.current.updateField(field, true); }, []);
  const hiddenBlockIds = views?.hidden;
  // Edit draws every block with the owner's values; one visitors don't see stays in place, quieted,
  // with the one item it needs and its Share, exactly as the page draws it for its owner (lab ppcomp-E).
  const consentPending = consent.state.kind === 'pending';
  const policy = draft?.policy;
  const toggleField = React.useCallback((field: PublicProfileField, shown: boolean) => {
    void consentLatest.current.updateField(field, shown);
  }, []);
  const figureControls = React.useMemo(() => policy
    ? publicProfileFigureControls({ policy, disabled: consentPending, onToggle: toggleField }) : null, [policy, consentPending, toggleField]);
  const owner = React.useMemo(() => hiddenBlockIds && draft && context && previewSnapshot ? {
    hiddenBlockIds, onlyYou: t('publicIdentity.editor.onlyYou'), ...figureControls,
    renderHiddenNote: (blockId: string) => <PublicProfileHiddenBlockNote blockId={blockId} layout={draft.layout} context={context}
      snapshot={previewSnapshot} policy={draft.policy} projector={projector ?? undefined} disabled={consent.state.kind === 'pending'}
      onShare={shareField} />,
  } : undefined, [hiddenBlockIds, draft, context, previewSnapshot, consent.state.kind, shareField, projector, figureControls]);
  const widgetPreview = React.useMemo<PublicProfileWidgetPreview | null>(() => !(context && draft && labels) ? null
    : !previewSnapshot ? { kind: 'unavailable', reason: awaitingReason } : {
    kind: 'ready',
    source: { context, policy: mode === 'edit' ? OWNER_POLICY : draft.policy, metadata: previewMetadata, snapshot: previewSnapshot,
      appearance: previewAppearance(draft, appliedAppearance) },
    projection: (mode === 'edit' ? ownerProjection : visitorProjection) ?? undefined,
    labels, usage, ...(mode === 'edit' && owner ? { owner } : {}),
  }, [context, previewSnapshot, draft, labels, mode, appliedAppearance, usage, awaitingReason, previewMetadata, owner, ownerProjection, visitorProjection]);

  const submit = React.useCallback(async () => {
    const candidate = widgetArea.candidate;
    if (!draft || !context?.service) return;
    if (!candidate) {
      setNotice(t('publicIdentity.profile.reasons.preparation_unavailable'));
      return;
    }
    const publishing = !record || record.state === 'draft';
    if (publishing && draft.appearance.kind === 'applied' && !appliedAppearance) {
      setNotice(t('publicIdentity.profile.reasons.asset_unavailable'));
      return;
    }
    const changesNow = resolvePublicProfileDraftChanges(record, draft);
    let appearance: PublicProfilePreparedAppearanceV1 | undefined;
    // A new theme on the applied planet or None look reuses that look's own prepared form.
    if (draft.appearance.kind === 'applied' && changesNow.appearance && appliedAppearance)
      appearance = { ...appliedAppearance, theme: draftVisitorTheme(draft) };
    if (draft.appearance.kind === 'candidate') {
      const prepared = await prepareLook({
        serverId,
        value: draft.appearance.atmosphere,
      });
      if (prepared.status !== 'ready') {
        setNotice(
          t(
            prepared.reason === 'account_retired'
              ? 'publicIdentity.profile.reasons.preparation_unavailable'
              : 'publicIdentity.profile.reasons.asset_unavailable',
          ),
        );
        return;
      }
      appearance = {
        atmosphere: prepared.prepared,
        theme: draft.appearance.theme,
      };
    }
    const review = (disclosure: PublicProfileLocalPreviewViewV1 | null,
      policy: PublicProfilePolicyV1, prepared: PublicProfilePreparedAppearanceV1,
      period: string, reviewContext: PublicProfileContextV1 = context, omittedCount = 0): Promise<boolean> => {
      const service = reviewContext.service;
      if (!service) return Promise.resolve(false);
      const picture = prepared.atmosphere.source === 'picture' ? prepared.atmosphere.picture : null;
      const pictureCopy = picture ? preparedPictureCopy(picture) : null;
      const signal = execution.getSignal();
      return new Promise(resolve => {
        let settled = false;
        let modalId: string;
        const finish = (confirmed: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          resolve(confirmed && !signal.aborted);
        };
        const abort = () => { finish(false); Modal.hide(modalId); };
        if (signal.aborted) { resolve(false); return; }
        modalId = Modal.show({
          component: PublicProfileReviewModal,
          props: {
            pageUrl: reviewContext.urls?.page ?? null, period,
            sharedFields: PUBLIC_PROFILE_FIELDS_V1.filter(field => policy.fields[field]),
            disclosure, preparationReason: !disclosure ? previewReason : null,
            omittedPrivateProjectCount: omittedCount,
            ...(picture && pictureCopy
              ? { renderPicture: () => <ReviewPictureBand picture={picture} data={pictureCopy.data} copyId={pictureCopy.copyId} /> }
              : {}),
            endToEndEncrypted: encryption === 'e2ee', indexable: policy.indexable,
            confirm: async () => { finish(true); }, cancel: () => finish(false),
          },
          onRequestClose: () => finish(false), onHostUnmount: () => finish(false),
          chrome: { kind: 'card', phonePresentation: 'sheet', testID: 'public-profile-review-modal',
            title: t('publicIdentity.review.titlePublish') },
          closeOnBackdrop: true,
        });
        signal.addEventListener('abort', abort, { once: true });
      });
    };
    setSubmitting(true);
    setNotice(null);
    try {
      const changed = resolvePublicProfileDraftChanges(record, draft);
      const preparedAppearance = appearance ?? previewAppearance(draft, appliedAppearance);
      const outcome = publishing
        ? await execution.execute('account.public_profile.publish', {
            intent: 'publish', policy: draft.policy, metadataSelection: draft.metadata, query,
            layout: candidate.selection, appearance: preparedAppearance,
          }, {
            ...(previewAdmission.current?.queryKey === queryKey
              ? { publicProfilePreviewAdmission: previewAdmission.current.pending } : {}),
            // Canonical preparation happens once before F2. Ask and dispatch retain
            // that exact effect; neither may silently reread different Usage facts.
            reviewPublicProfilePreparedAction: async effect => {
              if (effect.request.operation !== 'publish') return false;
              const body = effect.request.body;
              const view = projectPublicProfilePreview({ context: effect.publicationContext, policy: body.policy,
                metadata: body.metadata, snapshot: body.snapshot, layout: body.layout, appearance: body.appearance,
                relativePeriod: body.query.period.relative });
              return view ? review(view, body.policy, body.appearance,
                formatUsageCalendarPeriod(body.snapshot.period), effect.publicationContext, effect.omittedPrivateProjectCount ?? 0) : false;
            },
          })
        : await execution.execute('account.public_profile.update', {
            ...(changed.layout ? { layout: candidate.selection } : {}), ...(appearance ? { appearance } : {}),
            ...(changed.metadata ? { metadataSelection: draft.metadata } : {}), ...(changed.period ? { query } : {}),
          });
      if (!outcome.ok) {
        if (!isActionApprovalDeclinedErrorCode(outcome.errorCode)) setNotice(publicProfileMutationNotice(outcome));
        return;
      }
      const outcomeNotice = settlePublicProfileMutation(outcome.result, (record, omittedCount) => {
        seeded.current = false;
        acknowledge(record);
        setOmittedPrivateProjectCount(omittedCount);
      });
      if (outcomeNotice) setNotice(outcomeNotice);
      else if (publishing && context?.urls?.page) {
        setNoticeState({ text: t('publicIdentity.editor.statusPublished'), tone: 'success', link: context.urls.page });
        // The first Publish in front of the owner plays the page's one signature; a reload or an Apply never does.
        setPublishMoment(moment => (moment ?? 0) + 1);
      }
      else setNotice(publishing ? t('publicIdentity.editor.published') : t('publicIdentity.editor.applied'), 'success');
      // Undo applies the edition this one replaced; a picture it no longer has
      // on this device cannot be put back, so a changed picture look offers no Undo.
      setUndoable(!publishing && !outcomeNotice && record ? publicProfileUndo(record, changed, appliedAppearance) : null);
      // The publication push owns the edition read; a confirmed write is not another invalidation.
    } catch {
      setNotice(t('publicIdentity.profile.actionUncertain'));
      await reload();
    } finally {
      setSubmitting(false);
    }
  }, [
    widgetArea.candidate,
    draft,
    context,
    record,
    prepareLook,
    serverId,
    encryption,
    execution,
    query,
    appliedAppearance,
    acknowledge,
    reload,
  ]);

  // "Copied" only when the platform clipboard took the link; otherwise the link stays on the line to select.
  const copyLink = React.useCallback(async (link: string) => {
    const result = await execution.execute('clipboard.write', { text: link }).catch(() => null);
    if (result?.ok) setNoticeState(current => current?.link === link ? { ...current, copied: true } : current);
  }, [execution]);
  const undo = React.useCallback(async () => {
    const prior = undoable;
    if (!prior) return;
    setSubmitting(true);
    try {
      const outcome = await execution.execute('account.public_profile.update', prior);
      if (!outcome.ok) {
        if (!isActionApprovalDeclinedErrorCode(outcome.errorCode)) setNotice(publicProfileMutationNotice(outcome));
        return;
      }
      setUndoable(null);
      const undoNotice = settlePublicProfileMutation(outcome.result, record => {
        seeded.current = false;
        acknowledge(record);
      });
      if (undoNotice) setNotice(undoNotice);
      else setNotice(t('publicIdentity.editor.undone'), 'success');
      // The same publication push settles Undo's edition without a second read.
    } catch {
      setNotice(t('publicIdentity.profile.actionUncertain'));
      await reload();
    } finally {
      setSubmitting(false);
    }
  }, [undoable, execution, acknowledge, reload]);

  if (state.kind === 'failed') {
    return (
      <ItemList style={{ paddingTop: 0 }}>
        <SettingsPageHeader title={t('publicIdentity.editor.title')} />
        <SurfaceStateCard
          kind="error"
          title={t('publicIdentity.profile.loadFailedTitle')}
          reason={t('publicIdentity.profile.loadFailedBody')}
          action={{ label: t('publicIdentity.profile.retry'), onPress: reload }}
          replacesContent
        />
      </ItemList>
    );
  }
  const renderBand = draft
    ? profileBand(draft, recordAppearance, appliedPictureData, serverId, publishMoment)
    : undefined;
  const consentStatus = (
    <PublicProfileConsentStatus
      state={consent.state}
      onUndo={() => { void consent.undo(); }}
      onRetry={(field, shown) => { void consent.updateField(field, shown); }}
      onCheck={() => { void reload(); }}
    />
  );
  return (
    <ItemList style={{ paddingTop: 0 }} pageColumn="wide">
      {draft && labels ? (
        <PublicProfileWidgetPreviewProvider value={widgetPreview}>
        <PublicProfileEditor
          status={record?.state ?? 'draft'}
          renderEditBlocks={() => <PublicProfileWidgetArea widgetArea={widgetArea} clauses={areaUsage.clauses} />}
          mode={mode}
          onModeChange={setMode}
          changes={changeCount}
          ownerView={views?.owner ?? null}
          visitorView={views?.visitor ?? null}
          shellView={shellView}
          unavailable={!previewSnapshot && previewReason
            ? { reason: awaitingReason, onRetry: () => setAttempt(value => value + 1) } : null}
          hiddenBlockIds={views?.hidden ?? new Set()}
          pageLabels={labels}
          usage={usage}
          renderBand={renderBand}
          singleColumn={singleColumn}
          notice={notice}
          omittedPrivateProjectCount={omittedPrivateProjectCount}
          noticeTone={noticeState?.tone}
          noticeAction={undoable && notice
            ? { label: t('publicIdentity.publicData.consent.undo'), onPress: () => { void undo(); } }
            : noticeState?.link ? { testID: 'public-profile-editor-copy-link', onPress: () => { void copyLink(noticeState.link!); },
                label: noticeState.copied ? t('publicIdentity.share.copied') : t('publicIdentity.share.copyLink') } : null}
          noticeDetail={noticeState?.link ? publicProfileLinkLabel(noticeState.link) : null}
          noticeMoment={noticeState?.link ? publishMoment : null}
          onNoticeEntered={settlePublishMoment}
          noticeSecondaryAction={noticeState?.link ? { testID: 'public-profile-editor-badge', label: t('publicIdentity.share.output_badge'),
            onPress: () => openUsageRecapComposer({ query: normalizeUsageQuery(query), serverId, initialOutput: 'badge' }, RecapCommandBridge) } : null}
          submitting={submitting || consent.state.kind === 'pending'}
          canSubmit={widgetArea.candidate !== null}
          consentStatus={panel === 'publicData' ? null : consentStatus}
          onSubmit={() => {
            void submit();
          }}
          renderTools={() => (
            <>
              <View ref={lookAnchor} collapsable={false}>
                <RoundButton
                  testID="public-profile-editor-look"
                  size="small"
                  display="secondary"
                  title={t('publicIdentity.editor.look')}
                  onPress={() => setPanel('look')}
                />
              </View>
              <View ref={detailsAnchor} collapsable={false}>
                <RoundButton
                  testID="public-profile-editor-details"
                  size="small"
                  display="secondary"
                  title={t('publicIdentity.details.button')}
                  onPress={() => setPanel('details')}
                />
              </View>
              <View ref={dataAnchor} collapsable={false}>
                <RoundButton
                  testID="public-profile-editor-public-data"
                  size="small"
                  display="secondary"
                  title={t('publicIdentity.editor.publicData')}
                  onPress={() => setPanel('publicData')}
                />
              </View>
              <LookPopover
                open={panel === 'look'}
                anchorRef={lookAnchor}
                onRequestClose={() => setPanel(null)}
              >
                <PublicProfileLookPanel
                  serverId={serverId}
                  value={draftLookPresentation(draft)}
                  onChange={(atmosphere) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            appearance: {
                              kind: 'candidate',
                              atmosphere,
                              theme: draftVisitorTheme(current),
                            },
                          }
                        : current,
                    )
                  }
                />
              </LookPopover>
              <LookPopover
                open={panel === 'details'}
                anchorRef={detailsAnchor}
                onRequestClose={() => setPanel(null)}
                accessibilityLabel={t('publicIdentity.details.button')}
              >
                {scope ? (
                  <PublicProfileDetailsPanel
                    scope={scope}
                    policy={draft.policy}
                    metadata={draft.metadata}
                    onMetadataChange={(metadata) => setDraft((current) => current ? { ...current, metadata } : current)}
                    period={draft.period}
                    onPeriodChange={(period) => setDraft((current) => current ? { ...current, period } : current)}
                    theme={draftVisitorTheme(draft)}
                    themeUnavailableReason={draft.appearance.kind === 'applied' && recordAppearance?.atmosphere.source === 'picture'
                      ? t('publicIdentity.details.themePicture') : null}
                    onThemeChange={(theme) => setDraft((current) => current ? setPublicProfileDraftTheme(current, theme) : current)}
                    hasAccountPhoto={Boolean(context?.identity.avatarUrl)}
                  />
                ) : null}
              </LookPopover>
              <LookPopover
                open={panel === 'publicData'}
                anchorRef={dataAnchor}
                onRequestClose={() => setPanel(null)}
                accessibilityLabel={t('publicIdentity.publicData.title')}
              >
                <PublicProfilePublicData
                  policy={draft.policy}
                  placements={views?.placements ?? null}
                  disabled={consent.state.kind === 'pending'}
                  status={panel === 'publicData' ? consentStatus : null}
                  onToggle={(field, shown) => { void consent.updateField(field, shown); }}
                />
              </LookPopover>
            </>
          )}
        />
        </PublicProfileWidgetPreviewProvider>
      ) : (
        <>
          <SettingsPageHeader title={t('publicIdentity.editor.title')} />
          <SurfaceStateCard
            testID="public-profile-editor-loading"
            kind="loading"
            title={t('publicIdentity.editor.preparing')}
            replacesContent
          />
        </>
      )}
    </ItemList>
  );
}

function profileBand(draft: PublicProfileDraft, applied: PublicProfileAppearanceV1 | null, appliedPictureData: string | null, serverId: string,
  publishMoment: number | null)
  : ((geometry: HappierPublicProfileHeroGeometry) => React.ReactNode) | undefined {
  const presentation = draftLookPresentation(draft);
  if (presentation.source === 'none') return undefined;
  return geometry => <View style={[styles.band, { height: geometry.bandHeightPx }]}>
    <PublishRiseBand moment={publishMoment} bandHeightPx={geometry.bandHeightPx}>
      <ProfileLookBand draft={draft} applied={applied} appliedPictureData={appliedPictureData} serverId={serverId} />
    </PublishRiseBand>
  </View>;
}

/** Only the band follows a drag; the profile editor and its draft stay untouched until admission. */
function ProfileLookBand(props: Readonly<{ draft: PublicProfileDraft; applied: PublicProfileAppearanceV1 | null;
  appliedPictureData: string | null; serverId: string }>) {
  const { draft, applied, appliedPictureData, serverId } = props;
  const preview = usePublicProfileAtmospherePreviewValue(serverId);
  if (!preview && draft.appearance.kind === 'applied' && applied?.atmosphere.source === 'picture') {
    // The applied picture is the reviewed public copy, painted with its frozen look as visitors' pages are.
    const picture = applied.atmosphere.picture;
    return <PublicPictureBand picture={picture} data={appliedPictureData} copyId={picture.ref.id} />;
  }
  const presentation = preview ?? draftLookPresentation(draft);
  const target = { publicProfile: presentation, draftServerId: serverId };
  return <AtmospherePreview target={target} frame="band" />;
}

/** The members an Apply changed, as the edition it replaced held them; null when they cannot be put back. */
function publicProfileUndo(record: PublicProfileOwnerRecordV1, changed: ReturnType<typeof resolvePublicProfileDraftChanges>,
  appliedAppearance: PublicProfilePreparedAppearanceV1 | null): PublicProfileUpdateIntentV1 | null {
  if (changed.appearance && !appliedAppearance) return null;
  const prior = createPublicProfileDraft(record, { layout: { v: 1, items: [] } });
  const update = {
    ...(changed.layout && record.layout ? { layout: record.layout } : {}),
    ...(changed.appearance && appliedAppearance ? { appearance: appliedAppearance } : {}),
    ...(changed.metadata ? { metadataSelection: prior.metadata } : {}),
    ...(changed.period ? { query: normalizeUsageQuery(publicProfileDraftQuery(prior)) } : {}),
  };
  if (!Object.keys(update).length) return null;
  return update;
}

/** The review's picture at the public band's proportion, so the owner judges the crop visitors get. */
function ReviewPictureBand(props: React.ComponentProps<typeof PublicPictureBand>) {
  return <View style={styles.reviewBand}><PublicPictureBand {...props} /></View>;
}


function PublicProfileReviewModal(
  props: CustomModalInjectedProps &
    Readonly<{
      pageUrl: string | null;
      period: string;
      sharedFields: readonly (typeof PUBLIC_PROFILE_FIELDS_V1)[number][];
      disclosure: PublicProfileLocalPreviewViewV1 | null;
      preparationReason: PublicProfilePreparationUnavailableReasonV1 | null;
      omittedPrivateProjectCount: number;
      renderPicture?: () => React.ReactNode;
      endToEndEncrypted: boolean;
      indexable: boolean;
      confirm: () => Promise<void>;
      cancel: () => void;
    }>,
) {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <PublicProfileReview
      kind="publish"
      pageUrl={props.pageUrl}
      period={props.period}
      sharedFields={props.sharedFields}
      disclosure={props.disclosure}
      preparationReason={props.preparationReason}
      omittedPrivateProjectCount={props.omittedPrivateProjectCount}
      renderPicture={props.renderPicture}
      endToEndEncrypted={props.endToEndEncrypted}
      indexable={props.indexable}
      confirming={confirming}
      setChrome={props.setChrome}
      onCancel={() => { props.cancel(); props.onClose(); }}
      onConfirm={() => {
        setConfirming(true);
        void props.confirm().finally(props.onClose);
      }}
    />
  );
}

const styles = StyleSheet.create(() => ({
  // The band's own frame is the horizon the first-publish rise comes up from.
  band: { width: '100%', overflow: 'hidden' },
  reviewBand: {
    width: '100%',
    aspectRatio:
      HAPPIER_PUBLIC_PROFILE_HERO_METRICS.rasterWidthPx.wide /
      HAPPIER_PUBLIC_PROFILE_HERO_METRICS.bandHeightPx.wide,
  },
}));
