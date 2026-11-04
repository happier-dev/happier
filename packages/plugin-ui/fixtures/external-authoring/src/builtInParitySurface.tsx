import type { ReactElement } from 'react';
import { ApprovalPrompt, Button, Collection, NavigationList, PageHeader, Row, Stack, useHappierCollection } from '@happier-dev/plugin-ui/components';

type Review = Readonly<{ id: string; title: string; needsYou: boolean; unopened: boolean }>;

const REVIEWS: readonly Review[] = [
  { id: 'r1', title: 'Rotate the release key', needsYou: true, unopened: true },
  { id: 'r2', title: 'Update the changelog', needsYou: false, unopened: false },
];

/**
 * The built-in page pieces in one external surface: a header whose controls hang from the title's line with a copyable
 * id, the needs-you row highlight and the compact approval. Each is the component Happier's own pages draw.
 */
export function BuiltInParityExample(props: Readonly<{ text: (words: string) => string; onDecide: () => void }>): ReactElement {
  const { text } = props;
  const reviews = useHappierCollection({ items: REVIEWS, keyOf: (review) => review.id, openKey: null, onOpenChange: () => undefined });
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
            <Button title={text('Allow')} variant="primary" onPress={props.onDecide} />
            <Button title={text('Deny')} variant="plain" onPress={props.onDecide} />
          </Row>
        )}
      />
    </Stack>
  );
}
