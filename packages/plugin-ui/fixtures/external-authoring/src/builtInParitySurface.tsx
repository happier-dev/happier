import { useState, type ReactElement } from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import {
  ApprovalPrompt,
  Avatar,
  AvatarStack,
  Button,
  Collection,
  CollectionRowNeedsYouHighlight,
  CollectionSavedViewsStrip,
  CollectionSpaceIcon,
  CollectionTitleButton,
  HorizontalScrollEdgeMask,
  ModalCardFooterActions,
  NavigationList,
  PageHeader,
  PageLoadingRows,
  RegistryShelf,
  RegistryShelfAddControl,
  RegistrySourcesUnavailable,
  Row,
  Stack,
  Text,
  useHappierCollection,
  type CollectionSavedViewStripItem,
} from '@happier-dev/plugin-ui/components';

type Review = Readonly<{ id: string; title: string; needsYou: boolean; unopened: boolean }>;

const VIEWS: readonly CollectionSavedViewStripItem[] = [
  { id: 'mine', label: 'Assigned to me', icon: 'issue' },
  { id: 'team', label: 'My team', icon: 'pin' },
];

const REVIEWS: readonly Review[] = [
  { id: 'r1', title: 'Rotate the release key', needsYou: true, unopened: true },
  { id: 'r2', title: 'Update the changelog', needsYou: false, unopened: false },
];

/**
 * The built-in page pieces in one external surface: a header whose mark and controls hang from the title's line with
 * a copyable id, the spaces strip with its drag and digit shortcuts, the needs-you row highlight, the compact approval
 * and a group label whose detail end keeps same-named groups apart. Each is the component Happier's own pages draw.
 */
export function BuiltInParityExample(props: Readonly<{ text: (words: string) => string; onDecide?: () => void }>): ReactElement {
  const { text } = props;
  const hostApi = usePluginHostApi();
  const [viewId, setViewId] = useState('mine');
  const [views, setViews] = useState(VIEWS);
  const [decided, setDecided] = useState(false);
  const [scopeLabel, setScopeLabel] = useState('Release reviews');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const reviews = useHappierCollection({ items: REVIEWS, keyOf: (review) => review.id, openKey: null, onOpenChange: () => undefined });
  const chooseScope = async () => {
    const nextLabel = scopeLabel === 'My team' ? 'Release reviews' : 'My team';
    setScopeError(null);
    setScopeOpen(true);
    try {
      const confirmed = await hostApi.confirm(text('Switch to this review Space?'), {
        title: text(nextLabel),
      });
      if (confirmed) setScopeLabel(nextLabel);
    } catch {
      setScopeError(text('The review Space dialog could not be opened. Try again.'));
    } finally {
      setScopeOpen(false);
    }
  };
  const reorder = async (id: string, beforeId: string | null): Promise<boolean> => {
    setViews((current) => {
      const moved = current.find((view) => view.id === id);
      if (moved === undefined) return current;
      const rest = current.filter((view) => view.id !== id);
      const at = beforeId === null ? rest.length : rest.findIndex((view) => view.id === beforeId);
      return [...rest.slice(0, at), moved, ...rest.slice(at)];
    });
    return true;
  };
  return (
    <Stack gap="medium">
      <PageHeader
        title={text('Release reviews')}
        description={text('Everything waiting before the next release.')}
        actionsLayout="hang"
        meta={[
          { key: 'repository', text: 'acme/payments' },
          { key: 'path', text: '/srv/repositories/acme/payments/reviews', mono: true },
        ]}
        actions={<Button title={text('Refresh')} variant="plain" onPress={() => undefined} />}
      />
      <Row gap="small">
        <CollectionSpaceIcon size={20} icon={{ kind: 'icon', name: 'review' }} />
        <CollectionTitleButton testID="author-collection-title" label={text(scopeLabel)}
          accessibilityLabel={text('Choose review Space')} expanded={scopeOpen} hasPopup="dialog"
          onPress={() => { void chooseScope(); }} />
      </Row>
      {scopeError ? <Text testID="author-collection-scope-error" tone="danger" value={scopeError} /> : null}
      <CollectionSavedViewsStrip
        scope="external-authoring"
        items={views}
        selectedId={viewId}
        labels={{ title: text('Views'), add: text('New view') }}
        onSelect={(id) => { if (id !== null) setViewId(id); }}
        onAdd={() => undefined}
        onReorder={reorder}
        shortcuts
      />
      <Collection
        model={reviews}
        accessibilityLabel={text('Reviews')}
        presentation="list"
        detail="none"
        scroll="page"
        anatomy={{
          title: (review) => review.title,
          glyph: () => null,
          needsYou: (review) => (review.needsYou ? { unopened: review.unopened } : null),
          accessibilityLabel: (review) => review.title,
          columnTitles: { title: text('Review') },
        }}
      />
      {/* A row drawn outside Collection takes the same highlight under its own content. */}
      <Row gap="small">
        <CollectionRowNeedsYouHighlight unopened visible />
        <Text value={text('Rotate the signing key by hand')} />
      </Row>
      <NavigationList title={text('Machines')}>
        <NavigationList.Group title="Studio" detail="Mac mini" detailEnd="e3b5 · Offline" />
      </NavigationList>
      <ApprovalPrompt
        chrome="compact"
        tone="attention"
        eyebrow={text('Deploy')}
        title={text('Publish the release notes')}
        footer={(
          <Row gap="small">
            <Button title={text('Allow')} variant="primary" disabled={decided} onPress={() => { setDecided(true); props.onDecide?.(); }} />
            <Button title={text('Deny')} variant="plain" disabled={decided} onPress={() => { setDecided(true); props.onDecide?.(); }} />
          </Row>
        )}
      />
      <Row gap="small">
        <AvatarStack size={20} slot accessibilityLabel={text('Ada and Lin')} entries={[
          { key: 'ada', content: <Avatar name="Ada" /> },
          { key: 'lin', content: <Avatar name="Lin" /> },
        ]} />
        <Text value={text('Reviewing together')} />
      </Row>
      <HorizontalScrollEdgeMask width={240} style={{ width: 240, overflow: 'hidden' }}
        ramps={{ start: null, end: { solid: { fromEnd: 20 }, clear: { fromEnd: 0 } } }}>
        <Row gap="small"><Text value={text('Release notes · Signing · Publishing · Follow-up')} /></Row>
      </HorizontalScrollEdgeMask>
      <ModalCardFooterActions cancel={{ onPress: () => setLoadingPreview(false) }}
        cancelLabel={text('Cancel')} note={text('Preview the page while it loads.')}>
        <Button title={text('Preview loading')} onPress={() => setLoadingPreview(true)} />
      </ModalCardFooterActions>
      {loadingPreview ? <PageLoadingRows testID="author-page-loading" header loadingLabel={text('Loading the page')} /> : null}
      <RegistryPresentationExample text={text} />
    </Stack>
  );
}

type RegistryListing = Readonly<{ id: string; title: string; description: string }>;
const REGISTRY_LISTINGS: readonly RegistryListing[] = [
  { id: 'uptime', title: 'Know when my site is down', description: 'Check a service and collect its response.' },
  { id: 'release', title: 'Review a release', description: 'Gather the changes ready to ship.' },
  { id: 'triage', title: 'Triage incoming issues', description: 'Sort reports into the next useful step.' },
];
const REGISTRY_PROJECTION = {
  keyOf: (listing: RegistryListing) => listing.id,
  title: (listing: RegistryListing) => listing.title,
  description: (listing: RegistryListing) => listing.description,
  testID: (listing: RegistryListing) => listing.id,
};

function RegistryPresentationExample({ text }: Readonly<{ text: (words: string) => string }>): ReactElement {
  const [added, setAdded] = useState<readonly string[]>([]);
  const [opened, setOpened] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(true);
  return <Stack gap="small">
    <RegistryShelf
      testID="author-registry" title={text('From the registry')} items={REGISTRY_LISTINGS}
      projection={REGISTRY_PROJECTION} loading={false} columnTitle={text('Workflow')}
      where={() => text('Community registry')} onOpen={(listing) => setOpened(listing.title)}
      action={(listing) => <RegistryShelfAddControl
        testID={`author-registry.${listing.id}.control`} title={listing.title}
        state={added.includes(listing.id) ? 'added' : 'available'}
        addLabel={text('Add')} addedLabel={text('Added')} failedLabel={text('Try again')}
        onAdd={() => setAdded((current) => [...current, listing.id])}
      />}
    />
    {opened ? <Text value={opened} /> : null}
    <RegistrySourcesUnavailable testID="author-registry.unavailable" failures={unavailable ? [{
      key: 'private-registry', message: text('Private registry could not be reached'),
      details: [text('This example retains the suggestions already shown.')],
      onRetry: () => setUnavailable(false),
    }] : []} />
  </Stack>;
}
