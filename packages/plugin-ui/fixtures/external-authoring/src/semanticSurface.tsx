import { useCallback, useEffect, useMemo, useState } from 'react';
import { isRecord } from '@happier-dev/plugin-sdk';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Button,
  InlineCode,
  Collection,
  type ComposerDecorationSetV1,
  type ComposerHandle,
  defineUiSurface,
  Divider,
  ErrorState,
  Form,
  Item,
  ItemGroup,
  List,
  ListDetailLayout,
  Select,
  Stack,
  Status,
  Tabs,
  Text,
  Tree,
  type TreeItem,
  useComposer,
  useComposerView,
  usePluginHostApi,
  usePluginTranslation,
  usePluginUiFocusTarget,
  useSurfaceContext,
  WidgetFrame,
} from '@happier-dev/plugin-ui';
import { useHappierUiAccessibility, useHappierUiLocalization } from '@happier-dev/plugin-ui/environment';
import {
  CountedDisclosureItem, ItemAddRow, FloatingFrame as AuthorFloatingFrame, TechnicalDetailsDisclosure, HAPPIER_BALANCED_TEXT_WRAP,
  CollectionConditionEditor, conditionModelFromFilter, applyCollectionConditionEdit, compileEntityListFilterV1,
  type TechnicalDetailsLine, type CollectionConditionEditorProps,
} from '@happier-dev/plugin-ui/components';
import {
  HappierFloatingFrame as FloatingFrame, HappierStack, HappierText, resolveFloatingFrameRect, resolveHappierTreeFocusKey,
  useHappierCollection, type FrameRect, type HappierTreeNode,
} from '@happier-dev/plugin-ui/components';
import { externalReleaseReviews, externalReleaseStageSelection, externalReleaseStageField,
  externalReleaseStageRegistry, readExternalReleaseFilterLocation } from './releaseStage.js';

const externalReviews = externalReleaseReviews;
const releaseFilterLabels: CollectionConditionEditorProps['labels'] = {
  title: 'Release filter', clear: 'Clear', add: 'Add filter', addSearch: 'Choose field', back: 'Back', or: 'or',
  operators: { is: 'is', is_not: 'is not', before: 'before', after: 'after', between: 'between', unavailable: 'unavailable' },
  remove: field => `Remove ${field}`, count: count => `${count} reviews`, countPartial: count => `${count} loaded`,
  saveAsSpace: 'Save release filter', done: 'Done', noFields: 'No fields', noValues: 'No values',
};
const externalReviewReferences: readonly TechnicalDetailsLine[] = externalReviews.map((review) => ({
  key: review.id,
  label: review.title,
  value: review.id,
}));

const externalTreeNodes = [{
  key: 'review-root', parentKey: null, depth: 0, kind: 'branch', expanded: false,
}] satisfies readonly HappierTreeNode[];
const externalAvailableRect = { x: 0, y: 0, width: 640, height: 480 } satisfies FrameRect;

/** The author's own visible tree projection: a collapsed branch's children are simply absent. */
function externalReviewTree(expanded: boolean): readonly TreeItem[] {
  return [
    { key: 'review-root', parentKey: null, depth: 0, kind: 'branch', expanded, title: 'Reviews' },
    ...(expanded ? [{ key: 'review-current', parentKey: 'review-root', depth: 1, kind: 'leaf' as const, expanded: false, title: 'Current review', meta: 'today' }] : []),
  ];
}

const externalComposerRef = {
  kind: 'session',
  sessionId: 'external-composer-session',
} as const;

// `null` is accepted only at the public ComposerHandle operation boundary;
// it is not a synthetic decoration payload external authors can construct.
// @ts-expect-error A clear request is not a ComposerDecorationSetV1 value.
const externalComposerClearIsNotDecorationSet: ComposerDecorationSetV1 = null;
void externalComposerClearIsNotDecorationSet;

function matchesExternalReview(
  review: (typeof externalReviews)[number],
  query: string,
): boolean {
  return review.title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

/**
 * The advanced trusted-author tier is deliberately narrower in ergonomics,
 * not capability: it composes the exact shared presentation and projected
 * environment that Happier core consumes. The mounted surface still owns the
 * provider; authors only read the factual environment from it.
 */
function ExternalAuthoringAdvancedPanel() {
  const [previewOpen, setPreviewOpen] = useState(true);
  const { direction, locale } = useHappierUiLocalization();
  const { textScale } = useHappierUiAccessibility();
  const treeFocus = resolveHappierTreeFocusKey(externalTreeNodes, null);
  const frame = resolveFloatingFrameRect({
    rect: { x: 600, y: 440, width: 160, height: 120 },
    availableRect: externalAvailableRect,
  });

  return (
    <HappierStack
      direction="horizontal"
      gap={8}
      testID="external-advanced-authoring-facts"
    >
      <HappierText>{`Advanced ${locale} ${direction} ${textScale}`}</HappierText>
      <HappierText>{`Neutral owners ${treeFocus} ${frame.rect.x},${frame.rect.y}`}</HappierText>
      <FloatingFrame
        mode="docked"
        rect={frame.rect}
        availableRect={externalAvailableRect}
        aspectRatio={16 / 10}
        moveInput="surface"
        onRectChange={() => undefined}
        onModeChange={() => undefined}
        controls={<HappierText>Review preview controls</HappierText>}
        accessibilityLabel="Framed review preview"
      >
        <HappierText>Framed review preview</HappierText>
      </FloatingFrame>
      <AuthorFloatingFrame
        mode={previewOpen ? 'docked' : 'closed'}
        rect={frame.rect}
        availableRect={externalAvailableRect}
        aspectRatio={16 / 10}
        moveInput="surface"
        onRectChange={() => undefined}
        onModeChange={() => undefined}
        controls={<Button title="Close author preview" onPress={() => setPreviewOpen(false)} />}
        accessibilityLabel="Author controlled preview"
      >
        <Text>Author preview content</Text>
      </AuthorFloatingFrame>
    </HappierStack>
  );
}

/**
 * An external author's actual public surface used by the framework-owned
 * semantic proof. Its local state belongs to the author; mounting, semantics,
 * querying, and actions remain owned by the SDK Testkit and RNW environment.
 */
function ExternalAuthoringSemanticSurface(props: Pick<RenderContext, 'launchInput' | 'subPath'>) {
  const { locale } = useSurfaceContext();
  const composers = useComposer();
  const [composerHandle, setComposerHandle] = useState<ComposerHandle | null>(null);
  const composerView = useComposerView(composerHandle);
  const hostApi = usePluginHostApi();
  const [savedLocale, setSavedLocale] = useState<string | undefined>();
  const [reviewInput, setReviewInput] = useState<Record<string, unknown>>({ enabled: false, note: '' });
  const [reviewFormReceipt, setReviewFormReceipt] = useState<string | null>(null);
  const [authoringStatus, setAuthoringStatus] = useState<string | undefined>();
  const [composerAttachmentStatus, setComposerAttachmentStatus] = useState<string | undefined>();
  const [composerDecorationStatus, setComposerDecorationStatus] = useState<string | undefined>();
  const [reviewQuery, setReviewQuery] = useState('');
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>('current');
  const [reviewChoice, setReviewChoice] = useState<string | null>('current');
  const [widgetExpanded, setWidgetExpanded] = useState(true);
  const [reviewTreeExpanded, setReviewTreeExpanded] = useState(false);
  const [openedReviewKey, setOpenedReviewKey] = useState<string | null>(null);
  const releaseStage = isRecord(props.launchInput) && typeof props.launchInput.releaseStage === 'string'
    ? props.launchInput.releaseStage : undefined;
  const initialReleaseFilter = useMemo(() => readExternalReleaseFilterLocation(props.subPath) ?? externalReleaseStageSelection(releaseStage),
    [props.subPath, releaseStage]);
  const [releaseFilter, setReleaseFilter] = useState(initialReleaseFilter);
  useEffect(() => setReleaseFilter(initialReleaseFilter), [initialReleaseFilter]);
  const externalReleaseFieldCurrent = !isRecord(props.launchInput) || props.launchInput.releaseFieldCurrent !== false;
  const [releaseFieldWithdrawn, setReleaseFieldWithdrawn] = useState(false);
  const releaseFieldCurrent = externalReleaseFieldCurrent && !releaseFieldWithdrawn;
  const [releaseFilterOpen, setReleaseFilterOpen] = useState(false);
  const [releaseSaveError, setReleaseSaveError] = useState(false);
  const releaseRegistry = useMemo(() => externalReleaseStageRegistry(releaseFieldCurrent), [releaseFieldCurrent]);
  const releaseConditions = useMemo(() => conditionModelFromFilter(releaseRegistry, releaseFilter, { fields: {
    [externalReleaseStageField.id]: { label: 'Release stage', valueOptions: [
      { value: 'ready', label: 'Ready' }, { value: 'blocked', label: 'Blocked' }, { value: 'reviewing', label: 'Reviewing' },
    ] },
  } }), [releaseRegistry, releaseFilter]);
  const matchReleaseStage = useMemo(() => compileEntityListFilterV1(releaseRegistry, releaseFilter), [releaseRegistry, releaseFilter]);
  const filterReview = useCallback((review: (typeof externalReviews)[number]) => matchReleaseStage(review) === 'match', [matchReleaseStage]);
  const reviewModel = useHappierCollection({
    items: externalReviews, keyOf: (review) => review.id,
    filter: filterReview,
    openKey: null, onOpenChange: () => undefined,
  });
  const [reviewScope, setReviewScope] = useState<'current' | 'all'>('current');
  const [reviewSection, setReviewSection] = useState<'summary' | 'history'>('summary');
  const saveFocusTarget = usePluginUiFocusTarget();
  const translate = usePluginTranslation();
  const reviewLabel = `${translate('external.review.save', 'Save external review')} (${locale})`;

  useEffect(() => {
    let active = true;
    void composers.get(externalComposerRef).then((handle) => {
      if (active) setComposerHandle(handle);
    });
    return () => { active = false; };
  }, [composers]);

  const composerViewLabel = composerView.pending !== null
    ? 'External composer view loading'
    : composerView.error !== null
      ? 'External composer view unavailable'
      : composerView.result?.status === 'ready'
        ? `External composer view revision ${composerView.result.snapshot.revision}`
        : 'External composer view unavailable';

  return (
    <>
      <ExternalAuthoringAdvancedPanel />
      <Button
        title="Open an editable authoring draft"
        onPress={async () => {
          const result = await hostApi.executeAction('session.authoring.open', {
            seed: { prompt: 'Help me update this review integration.' },
          });
          setAuthoringStatus('kind' in result
            ? result.kind === 'opened'
              ? 'Draft opened; review and Send in Happier'
              : 'Draft unavailable; nothing sent'
            : 'Draft awaiting approval; nothing sent');
        }}
      />
      {authoringStatus ? <Status tone="info" label={authoringStatus} /> : null}
      <Button
        title={reviewLabel}
        focusTarget={saveFocusTarget}
        onPress={async () => {
          await hostApi.executeAction('save-external-review', { locale });
          setSavedLocale(locale);
        }}
      />
      <Status
        tone={composerView.result?.status === 'ready' ? 'info' : 'warning'}
        label={composerViewLabel}
      />
      <Button
        title="Add external composer attachment"
        onPress={async () => {
          const composer = await composers.get(externalComposerRef);
          if (!composer) {
            setComposerAttachmentStatus('External composer attachment unavailable');
            return;
          }

          const read = await composer.read();
          if (read.status !== 'ready') {
            setComposerAttachmentStatus('External composer attachment unavailable');
            return;
          }

          const result = await composer.apply({
            expectedRevision: read.snapshot.revision,
            operations: [{
              kind: 'attachment.add',
              attachmentLocalId: 'external-issue',
              value: {
                key: 'external-review',
                value: { reviewId: 'external-review' },
                presentation: { label: 'External review' },
              },
            }],
          });
          setComposerAttachmentStatus(
            result.status === 'applied'
              ? 'Added external composer attachment'
              : 'External composer attachment unavailable',
          );
        }}
      />
      <Button
        title="Clear external composer decorations"
        onPress={async () => {
          const composer = await composers.get(externalComposerRef);
          if (!composer) {
            setComposerDecorationStatus('External composer decorations unavailable');
            return;
          }
          await composer.setDecorations('external-review', null);
          setComposerDecorationStatus('Cleared external composer decorations');
        }}
      />
      <ListDetailLayout
        testID="external-resizable-collection" listTestID="external-resizable-list" detailTestID="external-resizable-detail"
        resizeKey="external-reviews" minListWidth={200} minDetailWidth={400} preferredListRatio={0.3}
        labels={{ resize: 'Resize external reviews' }}
        list={<Text value="External review rail" />} detail={<Text value="External review detail" />}
      />
      <List
        accessibilityLabel="External reviews"
        items={externalReviews}
        keyForItem={(review) => review.id}
        search={{
          label: 'Search external reviews',
          placeholder: 'Search reviews',
          testID: 'external-review-search',
          value: reviewQuery,
          onValueChange: setReviewQuery,
          filter: matchesExternalReview,
        }}
        selection={{
          selectedKey: selectedReviewId,
          onSelectedKeyChange: setSelectedReviewId,
        }}
        renderItem={(review) => <List.Item title={review.title} />}
      />
      <CountedDisclosureItem title="Older reviews" count={externalReviews.length - 1} testID="external-older-reviews">
        {externalReviews.slice(1).map((review) => <Item key={review.id} title={review.title} />)}
      </CountedDisclosureItem>
      <TechnicalDetailsDisclosure title="Technical details" lines={externalReviewReferences} testID="external-review-technical" />
      <HappierText style={[{ textAlign: 'center' }, HAPPIER_BALANCED_TEXT_WRAP]}>Opening the review on the reviewer's Machine</HappierText>
      <WidgetFrame
        frameStyle="card"
        placement="board"
        title="Review choices"
        disclosure={{ collapsed: !widgetExpanded, onCollapsedChange: (collapsed) => setWidgetExpanded(!collapsed),
          expandLabel: 'Expand review choices', collapseLabel: 'Collapse review choices' }}
      >
        {props.subPath === undefined ? null : <ItemGroup title="Release filter"
          description="Filter the held reviews and keep this selection on this device.">
          <Item title="Review selection" accessory={<Button title="Edit release filter" variant="plain"
            onPress={() => setReleaseFilterOpen(true)} />} />
          {releaseFilterOpen ? <CollectionConditionEditor model={releaseConditions} labels={releaseFilterLabels}
            onChange={edit => setReleaseFilter(current => applyCollectionConditionEdit(releaseRegistry, current, edit))}
            onDone={() => setReleaseFilterOpen(false)}
            onSaveAsSpace={async () => {
              setReleaseSaveError(false);
              try {
                const settled = await hostApi.replacePageLocation(`release-filter/${encodeURIComponent(JSON.stringify(releaseFilter))}`);
                setReleaseFilter(readExternalReleaseFilterLocation(settled.subPath) ?? {});
                setReleaseFilterOpen(false);
              } catch { setReleaseSaveError(true); }
            }} /> : null}
          <Item title="Release stage field" accessory={<Button variant="plain"
            title={releaseFieldWithdrawn ? 'Restore release field' : 'Withdraw release field'}
            disabled={!externalReleaseFieldCurrent}
            onPress={() => setReleaseFieldWithdrawn(current => !current)} />} />
          {releaseConditions.rows.some(row => !row.available) ? <Status tone="warning" label="Release stage unavailable" /> : null}
          {releaseSaveError ? <Status tone="warning" label="Couldn’t save the release filter. Try again." /> : null}
        </ItemGroup>}
        <Collection
          model={reviewModel}
          accessibilityLabel="External review choice"
          presentation="list"
          detail="none"
          scroll="page"
          minListWidth={240}
          minDetailWidth={240}
          preferredListRatio={0.5}
          anatomy={{ glyph: () => null, title: (review) => review.title,
            accessibilityLabel: (review) => `Choose ${review.title}`, columnTitles: { title: 'Review' } }}
          selection={{ single: { value: reviewChoice, onValueChange: setReviewChoice } }}
        />
      </WidgetFrame>
      <Tree
        items={externalReviewTree(reviewTreeExpanded)}
        accessibilityLabel="External review tree"
        selectedKey={openedReviewKey}
        onExpandedChange={(_key, expanded) => setReviewTreeExpanded(expanded)}
        onActivate={setOpenedReviewKey}
        expandLabel={(item) => `Expand ${item.title}`}
        collapseLabel={(item) => `Collapse ${item.title}`}
        testID="external-review-tree"
      />
      <Form
        hints={{
          title: 'External review form',
          submitLabel: 'Submit external review form',
          fields: [
            { path: 'name', title: 'Review name', widget: 'text', defaultValue: 'Release review' },
            { path: 'enabled', title: 'Review enabled', widget: 'boolean', defaultValue: true },
            { path: 'note', title: 'Review note', widget: 'text', defaultValue: 'Suggested note' },
            { path: 'count', title: 'Review count', widget: 'integer', defaultValue: 0 },
          ],
        }}
        value={reviewInput}
        onChange={setReviewInput}
        onSubmit={(input) => setReviewFormReceipt(JSON.stringify(input))}
      />
      {reviewFormReceipt === null ? null : <Status tone="info" label={`External review form submitted: ${reviewFormReceipt}`} />}
      <ItemGroup
        title="External review scope"
        description={<>Reviews run through <InlineCode>happier review</InlineCode> on the selected computer.</>}
      >
        <ItemAddRow title="Add review scope" onPress={() => setReviewScope('all')} testID="external-add-review-scope" />
        <Item
          title="External review filter"
          accessoryWraps
          fieldAccessory
          accessoryOutsidePressable
          accessory={<Select
            presentation="field"
            label="External review filter"
            options={[
              { value: 'current', label: 'Current review' },
              { value: 'all', label: 'All reviews' },
            ]}
            value={reviewScope}
            onChange={(next) => {
              if (next === 'current' || next === 'all') setReviewScope(next);
            }}
          />}
        />
      </ItemGroup>
      <Tabs
        value={reviewSection}
        onValueChange={(next) => {
          if (next === 'summary' || next === 'history') setReviewSection(next);
        }}
        ariaLabel="External review sections"
      >
        <Tabs.Item value="summary" title="Summary">
          <Text value="External review summary" />
        </Tabs.Item>
        <Tabs.Item value="history" title="History">
          <Text value="External review history" />
        </Tabs.Item>
      </Tabs>
      <Divider accessibilityLabel="External review sections" />
      <Button title="Clear external review" onPress={() => { setSavedLocale(undefined); }} />
      {savedLocale === undefined ? (
        <Text value="External review pending" />
      ) : (
        <Status tone="success" label={`Saved external review (${savedLocale})`} />
      )}
      {composerAttachmentStatus === undefined ? null : (
        <Status
          tone={composerAttachmentStatus === 'Added external composer attachment' ? 'success' : 'warning'}
          label={composerAttachmentStatus}
        />
      )}
      {composerDecorationStatus === undefined ? null : (
        <Status
          tone={composerDecorationStatus === 'Cleared external composer decorations' ? 'success' : 'warning'}
          label={composerDecorationStatus}
        />
      )}
    </>
  );
}

/** Displays only host-admitted inputs; input eligibility and layout storage remain host-owned. */
function ExternalProjectSurface({ launchInput }: RenderContext) {
  const { target } = useSurfaceContext();
  const checkout = isRecord(launchInput) && isRecord(launchInput.checkout) ? launchInput.checkout : null;
  if ((target.kind !== 'app' && target.kind !== 'project') || !checkout
    || typeof checkout.projectKey !== 'string'
    || typeof checkout.serverId !== 'string' || typeof checkout.machineId !== 'string'
    || typeof checkout.rootPath !== 'string') {
    return <ErrorState layout="line" title="This checkout is unavailable" />;
  }
  const source = isRecord(launchInput) && isRecord(launchInput.source) ? launchInput.source : null;
  return (
    <Stack gap="small">
      <Text value={`Project ${target.kind === 'project' ? target.projectId : checkout.projectKey}`} />
      <Text value={`${checkout.serverId} · ${checkout.machineId} · ${checkout.rootPath}`} tone="secondary" />
      {source && typeof source.sourceId === 'string' ? <Text value={`Source ${source.sourceId}`} /> : null}
    </Stack>
  );
}

function ExternalAuthoringSurface(context: RenderContext) {
  const { target } = useSurfaceContext();
  return target.kind === 'project' || (target.kind === 'app'
    && isRecord(context.launchInput) && isRecord(context.launchInput.checkout))
    ? <ExternalProjectSurface {...context} />
    : <ExternalAuthoringSemanticSurface launchInput={context.launchInput} subPath={context.subPath} />;
}

export const renderExternalAuthoringSemanticSurface = defineUiSurface(
  ExternalAuthoringSurface,
);
