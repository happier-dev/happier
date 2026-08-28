import { createRoot } from 'react-dom/client';
import { useMemo, useState } from 'react';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import { createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
  Badge,
  Button,
  Card,
  Field,
  Form,
  Heading,
  List,
  Row,
  Screen,
  Select,
  Spinner,
  Stack,
  Status,
  Tabs,
  Text,
  TextField,
  Toggle,
  ValidationMessage,
} from '@happier-dev/plugin-ui';
import { PluginUiProvider } from '@happier-dev/plugin-ui/advanced';

const virtualizedItems = Object.freeze(Array.from({ length: 240 }, (_value, index) => Object.freeze({
  id: `row-${index + 1}`,
  title: `Review item ${index + 1}`,
  detail: `Revision ${index + 1}`,
})));

function matchesVirtualizedReview(
  item: (typeof virtualizedItems)[number],
  query: string,
): boolean {
  const normalizedQuery = query.toLocaleLowerCase();
  return item.title.toLocaleLowerCase().includes(normalizedQuery)
    || item.detail.toLocaleLowerCase().includes(normalizedQuery);
}

const initialContext = createSurfaceContextFixture({
  platform: 'web',
  safeAreaInsets: { top: 16, right: 16, bottom: 16, left: 16 },
});

// This isolated external-author browser fixture models the genuine host-API
// boundary only; it deliberately does not manufacture the private Popover host.
function unsupportedBrowserHostMethod(): never {
  throw new Error('This external browser fixture only exercises the mounted presentation boundary.');
}

const browserHostApi: PluginUiHostApi = {
  version: () => ({ apiVersion: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion, wireVersion: 1, methods: ['context', 'watchContext'] as const }),
  publishCurrentUiContext: () => undefined,
  context: async () => initialContext,
  watchContext: async () => ({ dispose() {} }),
  executeAction: async () => unsupportedBrowserHostMethod(),
  selectActionInput: async () => unsupportedBrowserHostMethod(),
  openNewSession: async () => unsupportedBrowserHostMethod(),
  readResource: async () => unsupportedBrowserHostMethod(),
  statOpenableContent: async () => unsupportedBrowserHostMethod(),
  readOpenableContent: async () => unsupportedBrowserHostMethod(),
  watchResource: async () => unsupportedBrowserHostMethod(),
  activeComposer: async () => unsupportedBrowserHostMethod(),
  readComposer: async () => unsupportedBrowserHostMethod(),
  watchComposer: async () => unsupportedBrowserHostMethod(),
  applyComposer: async () => unsupportedBrowserHostMethod(),
  focusComposer: async () => unsupportedBrowserHostMethod(),
  setComposerDecorations: async () => unsupportedBrowserHostMethod(),
  acquireComposerInputLock: async () => unsupportedBrowserHostMethod(),
  pickComposerMedia: async () => unsupportedBrowserHostMethod(),
  inspectComposerContent: async () => unsupportedBrowserHostMethod(),
  releaseComposerContent: async () => unsupportedBrowserHostMethod(),
  openSurface: async () => unsupportedBrowserHostMethod(),
  replacePageLocation: async () => unsupportedBrowserHostMethod(),
  notify: async () => unsupportedBrowserHostMethod(),
  confirm: async () => unsupportedBrowserHostMethod(),
  diagnostic: () => undefined,
  readClipboard: async () => unsupportedBrowserHostMethod(),
  writeClipboard: async () => unsupportedBrowserHostMethod(),
  openExternalLink: async () => unsupportedBrowserHostMethod(),
};

function settleAfter(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, milliseconds); });
}

function BrowserFixture() {
  const [textScale, setTextScale] = useState(1);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({ note: '' });
  const [saveStatus, setSaveStatus] = useState('Ready to save');
  const [referenceTitle, setReferenceTitle] = useState('Current review');
  const [referenceSummary, setReferenceSummary] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const [reviewScope, setReviewScope] = useState<'current' | 'all'>('current');
  const [reviewOrder, setReviewOrder] = useState<'recent' | 'title'>('recent');
  const [referenceControlsStatus, setReferenceControlsStatus] = useState('Review controls ready');
  const [tab, setTab] = useState('overview');
  const [retired, setRetired] = useState(false);
  const [reviewQuery, setReviewQuery] = useState('');
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>('row-1');
  const context = useMemo(() => createSurfaceContextFixture({
    platform: 'web',
    textScale,
    reducedMotion,
    safeAreaInsets: { top: 16, right: 16, bottom: 16, left: 16 },
  }), [reducedMotion, textScale]);

  return (
    <PluginUiProvider hostApi={browserHostApi} context={context}>
      <Screen
        safeArea
        testID="external-browser-screen"
        style={{ width: '100%', maxWidth: 860, alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 24 }}
      >
        <Stack gap="large">
          <Stack gap="small">
            <Badge tone="info" value="Exact packed public API" />
            <Heading level={1} value="Plugin UI browser fixture" />
            <Text
              testID="text-scale-sample"
              value="A compact external-author surface that exercises dynamic type, focus, forms, state, and list locality."
            />
          </Stack>

          <Card>
            <Stack gap="medium">
              <Heading level={2} value="Accessibility controls" />
              <Row gap="small" wrap>
                <Button
                  title={textScale === 1 ? 'Use 200% text' : 'Use 100% text'}
                  onPress={() => setTextScale((current) => current === 1 ? 2 : 1)}
                />
                <Button
                  title={reducedMotion ? 'Allow motion' : 'Reduce motion'}
                  variant="secondary"
                  onPress={() => setReducedMotion((current) => !current)}
                />
                <Button title="Unavailable action" variant="plain" disabled onPress={() => undefined} />
              </Row>
              <Status
                tone="info"
                label={`Text ${textScale === 2 ? '200%' : '100%'} · ${reducedMotion ? 'Reduced motion' : 'Motion allowed'}`}
                pulsing={!reducedMotion}
                testID="accessibility-status"
              />
              <Spinner accessibilityLabel="Fixture activity" testID="fixture-spinner" />
            </Stack>
          </Card>

          {retired ? (
            <Status tone="success" label="Preview retired" testID="retirement-status" />
          ) : (
            <Stack gap="large">
              <Card testID="interactive-preview">
                <Stack gap="medium">
                  <Tabs value={tab} onValueChange={setTab} ariaLabel="Fixture sections" testID="fixture-tabs">
                    <Tabs.Item value="overview" title="Overview">
                      <Text value="Keyboard focus can move between controlled tabs without changing their owner." />
                    </Tabs.Item>
                    <Tabs.Item value="details" title="Details">
                      <Text value="The selected tab remains controlled by the external author." />
                    </Tabs.Item>
                  </Tabs>
                  <Form
                    hints={{
                      title: 'Save a note',
                      description: 'The public Form owns field semantics and pending state.',
                      submitLabel: 'Save note',
                      fields: [{ path: 'note', title: 'Note', widget: 'text', required: true }],
                    }}
                    value={draft}
                    onChange={setDraft}
                    onSubmit={async (value) => {
                      setSaveStatus('Saving note');
                      await settleAfter(250);
                      setSaveStatus(`Saved ${String(value.note ?? '')}`.trim());
                    }}
                    onCancel={() => {
                      setDraft({ note: '' });
                      setSaveStatus('Editing cancelled');
                    }}
                    cancelLabel="Discard note"
                    testID="fixture-form"
                  />
                  <Status tone="success" label={saveStatus} testID="save-status" />
                </Stack>
              </Card>

              <Card testID="form-controls-reference">
                <Stack gap="medium">
                  <Heading level={2} value="Review controls" />
                  <Text value="A public reference keeps the author-owned draft values explicit while Plugin UI owns each field's semantics." />
                  <Form.Field label="Review title" required>
                    <Form.TextField
                      label="Review title"
                      value={referenceTitle}
                      onChange={setReferenceTitle}
                      placeholder="Name this review"
                      required
                      testID="reference-review-title"
                    />
                  </Form.Field>
                  <Field label="Review summary">
                    <TextField
                      label="Review summary"
                      value={referenceSummary}
                      onChange={setReferenceSummary}
                      placeholder="Optional context"
                      multiline
                      testID="reference-review-summary"
                    />
                  </Field>
                  <Form.Field label="Include archived reviews">
                    <Form.Toggle
                      label="Include archived reviews"
                      value={includeArchived}
                      onChange={setIncludeArchived}
                      testID="reference-include-archived"
                    />
                  </Form.Field>
                  <Field label="Show review details">
                    <Toggle
                      label="Show review details"
                      value={showDetails}
                      onChange={setShowDetails}
                      testID="reference-show-details"
                    />
                  </Field>
                  <Form.Field label="Review scope">
                    <Form.Select
                      label="Review scope"
                      options={[
                        { value: 'current', label: 'Current review' },
                        { value: 'all', label: 'All reviews' },
                      ]}
                      value={reviewScope}
                      onChange={(next) => {
                        if (next === 'current' || next === 'all') setReviewScope(next);
                      }}
                      testID="reference-review-scope"
                    />
                  </Form.Field>
                  <Field label="Review order">
                    <Select
                      label="Review order"
                      options={[
                        { value: 'recent', label: 'Most recent' },
                        { value: 'title', label: 'Title' },
                      ]}
                      value={reviewOrder}
                      onChange={(next) => {
                        if (next === 'recent' || next === 'title') setReviewOrder(next);
                      }}
                      testID="reference-review-order"
                    />
                  </Field>
                  {referenceTitle.trim() === '' ? (
                    <Form.ValidationMessage message="A review title is required." testID="reference-title-required" />
                  ) : null}
                  {referenceSummary.trim() === '' ? (
                    <ValidationMessage message="Add context before sharing this review." testID="reference-summary-guidance" />
                  ) : null}
                  <Form.Actions>
                    <Button
                      title="Save review controls"
                      onPress={() => {
                        setReferenceControlsStatus(
                          `Saved ${reviewScope} reviews in ${reviewOrder} order${includeArchived ? ' with archived reviews' : ''}${showDetails ? ' with details' : ''}`,
                        );
                      }}
                    />
                  </Form.Actions>
                  <Status tone="info" label={referenceControlsStatus} testID="reference-controls-status" />
                </Stack>
              </Card>

              <Card>
                <Stack gap="medium">
                  <Heading level={2} value="Virtualized review list" />
                  <Text value="Search filters 240 authored rows before the platform virtualizer; a blank query retains their source array." />
                  <List
                    accessibilityLabel="Virtualized review items"
                    testID="virtualized-list"
                    style={{ height: 320 }}
                    items={virtualizedItems}
                    keyForItem={(item) => item.id}
                    search={{
                      label: 'Search review items',
                      placeholder: 'Search title or revision',
                      testID: 'external-browser-review-search',
                      value: reviewQuery,
                      onValueChange: setReviewQuery,
                      filter: matchesVirtualizedReview,
                    }}
                    selection={{
                      selectedKey: selectedReviewId,
                      onSelectedKeyChange: setSelectedReviewId,
                    }}
                    header={({ selectedItem }) => (
                      <Status
                        tone="info"
                        label={selectedItem === null ? 'No review selected' : `Selected ${selectedItem.title}`}
                      />
                    )}
                    renderItem={(item) => (
                      <List.Item
                        testID={`virtual-row-${item.id}`}
                        title={item.title}
                        detail={item.detail}
                      />
                    )}
                  />
                </Stack>
              </Card>

              <Button title="Retire preview" variant="secondary" onPress={() => setRetired(true)} />
            </Stack>
          )}
        </Stack>
      </Screen>
    </PluginUiProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('External author browser fixture root is missing.');
createRoot(root).render(<BrowserFixture />);
