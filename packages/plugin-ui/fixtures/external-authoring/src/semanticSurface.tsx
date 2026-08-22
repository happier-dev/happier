import { useEffect, useState } from 'react';
import {
  Button,
  type ComposerDecorationSetV1,
  type ComposerHandle,
  defineUiSurface,
  Divider,
  Form,
  List,
  Select,
  Status,
  Tabs,
  Text,
  useComposer,
  useComposerView,
  usePluginHostApi,
  usePluginTranslation,
  usePluginUiFocusTarget,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { useHappierUiAccessibility, useHappierUiLocalization } from '@happier-dev/plugin-ui/environment';
import { HappierStack, HappierText } from '@happier-dev/plugin-ui/presentation';

const externalReviews = Object.freeze([
  Object.freeze({ id: 'current', title: 'Current review' }),
  Object.freeze({ id: 'terminal', title: 'Terminal review' }),
  Object.freeze({ id: 'release', title: 'Release review' }),
]);

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
  const { direction, locale } = useHappierUiLocalization();
  const { textScale } = useHappierUiAccessibility();

  return (
    <HappierStack
      direction="horizontal"
      gap={8}
      testID="external-advanced-authoring-facts"
    >
      <HappierText>{`Advanced ${locale} ${direction} ${textScale}`}</HappierText>
    </HappierStack>
  );
}

/**
 * An external author's actual public surface used by the framework-owned
 * semantic proof. Its local state belongs to the author; mounting, semantics,
 * querying, and actions remain owned by the SDK Testkit and RNW environment.
 */
function ExternalAuthoringSemanticSurface() {
  const { locale } = useSurfaceContext();
  const composers = useComposer();
  const [composerHandle, setComposerHandle] = useState<ComposerHandle | null>(null);
  const composerView = useComposerView(composerHandle);
  const hostApi = usePluginHostApi();
  const [savedLocale, setSavedLocale] = useState<string | undefined>();
  const [composerAttachmentStatus, setComposerAttachmentStatus] = useState<string | undefined>();
  const [composerDecorationStatus, setComposerDecorationStatus] = useState<string | undefined>();
  const [reviewQuery, setReviewQuery] = useState('');
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>('current');
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
      <Form
        hints={{
          title: 'External review form',
          fields: [],
        }}
        value={{}}
        onChange={() => undefined}
        onSubmit={() => undefined}
      />
      <Select
        label="External review filter"
        options={[
          { value: 'current', label: 'Current review' },
          { value: 'all', label: 'All reviews' },
        ]}
        value={reviewScope}
        onChange={(next) => {
          if (next === 'current' || next === 'all') setReviewScope(next);
        }}
      />
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

export const renderExternalAuthoringSemanticSurface = defineUiSurface(
  ExternalAuthoringSemanticSurface,
);
