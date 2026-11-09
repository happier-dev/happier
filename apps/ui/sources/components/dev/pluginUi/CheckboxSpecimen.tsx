import * as React from 'react';
import {
  Checkbox,
  DiffStat,
  Item,
  List,
  Row,
  Stack,
  Text,
} from '@happier-dev/plugin-ui';

type SpecimenFile = Readonly<{
  path: string;
  added: number;
  removed: number;
  /** null: GitHub has not answered for this file yet. */
  viewed: boolean | null;
  note?: Readonly<{ tone: 'muted' | 'danger'; value: string }>;
}>;

const FILES: readonly SpecimenFile[] = [
  { path: 'src/intents/confirm.ts', added: 72, removed: 18, viewed: true },
  {
    path: 'src/intents/retry.ts',
    added: 58,
    removed: 0,
    viewed: false,
    note: { tone: 'muted', value: 'Changed since viewed' },
  },
  {
    path: 'src/intents/__tests__/confirm.race.test.ts',
    added: 64,
    removed: 0,
    viewed: false,
  },
  {
    path: 'src/http/stripeClient.ts',
    added: 11,
    removed: 9,
    viewed: false,
    note: { tone: 'danger', value: 'Not saved to GitHub' },
  },
  {
    path: 'src/errors/PaymentIntentConflict.ts',
    added: 4,
    removed: 1,
    viewed: true,
  },
  { path: 'docs/runbooks/payments.md', added: 5, removed: 9, viewed: null },
];

/**
 * The plugin-ui Checkbox in a native Files panel's row slot (GitHub Viewed): checked, unchecked, changed
 * since viewed, refused, unknown (reserved), and a toggle that holds its spinner while it saves. A plugin
 * author's surface: public plugin-ui components only, with the host's own checkbox mark.
 */
export function PluginCheckboxSpecimen() {
  const [viewed, setViewed] = React.useState(
    () => new Map(FILES.map((file) => [file.path, file.viewed])),
  );
  const [pending, setPending] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggle = React.useCallback((path: string, next: boolean) => {
    setPending((current) => new Set(current).add(path));
    setTimeout(() => {
      setViewed((current) => new Map(current).set(path, next));
      setPending((current) => {
        const rest = new Set(current);
        rest.delete(path);
        return rest;
      });
    }, 1500);
  }, []);
  const count = [...viewed.values()].filter((value) => value === true).length;
  const [group, setGroup] = React.useState<boolean | 'mixed'>('mixed');
  return (
    <Stack gap="large" testID="plugin-checkbox-specimen">
      <List
        accessibilityLabel="Files this pull request changes"
        density="compact"
        sections={[{ key: 'files', title: 'Source', data: FILES }]}
        keyForItem={(file) => file.path}
        header={
          <Text
            testID="plugin-checkbox-count"
            variant="meta"
            tone="secondary"
            value={`${count} of ${FILES.length} viewed`}
          />
        }
        renderItem={(file) => (
          <Item
            title={file.path}
            density="tight"
            titleEllipsizeMode="middle"
            accessory={
              <Row gap="medium" align="center">
                <DiffStat added={file.added} removed={file.removed} />
                <Row gap="small" align="center">
                  {file.note && viewed.get(file.path) === file.viewed ? (
                    <Text
                      variant="meta"
                      tone={file.note.tone}
                      numberOfLines={1}
                      value={file.note.value}
                    />
                  ) : null}
                  <Checkbox
                    testID={`plugin-checkbox-${file.path}`}
                    size="compact"
                    checked={viewed.get(file.path) ?? null}
                    pending={pending.has(file.path)}
                    label="Viewed"
                    accessibilityLabel={`${file.path.split('/').pop()}, viewed on GitHub`}
                    onChange={(next) => {
                      toggle(file.path, next);
                    }}
                  />
                </Row>
              </Row>
            }
            accessoryOutsidePressable
                        accessoryWraps
            onPress={() => {}}
          />
        )}
      />
      <Row gap="large" align="center">
        <Checkbox
          testID="plugin-checkbox-mixed"
          checked={group}
          label="Select all"
          onChange={(next) => {
            setGroup(next);
          }}
        />
        <Checkbox
          testID="plugin-checkbox-disabled"
          checked={false}
          disabled
          label="Unavailable"
          onChange={() => {}}
        />
        <Checkbox
          testID="plugin-checkbox-regular"
          checked
          label="Regular"
          onChange={() => {}}
        />
      </Row>
    </Stack>
  );
}
