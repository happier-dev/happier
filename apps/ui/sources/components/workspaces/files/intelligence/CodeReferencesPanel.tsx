import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { LanguageIntelligenceQueryResult } from '@happier-dev/protocol/machines/languageIntelligence';

import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { CodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import type { CodeIntelligencePosition } from '@/sync/domains/workspaces/languageIntelligence/codeIdentifiers';
import { t } from '@/text';

import { CodeReferencesList, type CodeReferencesListProps } from './CodeReferencesList';

type HierarchyAnswer = Extract<LanguageIntelligenceQueryResult, { status: 'ok'; kind: 'callHierarchy' }>;
type CallItem = HierarchyAnswer['items'][number];

/** The desktop References panel and phone sheet share both navigation views. */
export function CodeReferencesPanel(props: Readonly<{
  controller: CodeIntelligenceController;
  position: CodeIntelligencePosition | null;
  supportsCalls: boolean;
  references: CodeReferencesListProps;
}>): React.ReactElement {
  const [tab, setTab] = React.useState<'references' | 'calls'>('references');
  return (
    <View>
      {props.supportsCalls && props.position ? (
        <View style={styles.controls}>
          <SegmentedTabBar
            compact
            tabs={[
              { id: 'references', label: t('files.pane.intelligence.references') },
              { id: 'calls', label: t('files.pane.intelligence.calls') },
            ]}
            activeTabId={tab}
            onSelectTab={setTab}
            testIDPrefix="code-navigation-tab"
          />
        </View>
      ) : null}
      {tab === 'calls' && props.supportsCalls && props.position ? (
        <CodeCallsList controller={props.controller} position={props.position} onOpen={props.references.onOpen} />
      ) : <CodeReferencesList {...props.references} />}
    </View>
  );
}

function CodeCallsList(props: Readonly<{
  controller: CodeIntelligenceController;
  position: CodeIntelligencePosition;
  onOpen: CodeReferencesListProps['onOpen'];
}>): React.ReactElement {
  const [direction, setDirection] = React.useState<'incoming' | 'outgoing'>('incoming');
  const [items, setItems] = React.useState<readonly CallItem[] | null>(null);
  const [item, setItem] = React.useState<CallItem | null>(null);
  const [answer, setAnswer] = React.useState<HierarchyAnswer | null>(null);
  const [checking, setChecking] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    const operation = new AbortController();
    setItems(null);
    setItem(null);
    setAnswer(null);
    setFailed(false);
    setChecking(true);
    void props.controller.callHierarchy({ direction: 'prepare', position: props.position }, operation.signal).then(result => {
      if (operation.signal.aborted) return;
      if (result?.status === 'ok' && result.kind === 'callHierarchy') {
        setItems(result.items);
        setItem(result.items.length === 1 ? result.items[0] : null);
      } else setFailed(true);
      setChecking(false);
    });
    return () => operation.abort();
  }, [props.controller, props.position.line, props.position.character, retry]);
  React.useEffect(() => {
    if (!item) return;
    const operation = new AbortController();
    setAnswer(null);
    setChecking(true);
    setFailed(false);
    void props.controller.callHierarchy({ direction, itemId: item.itemId, serverId: item.serverId }, operation.signal).then(result => {
      if (operation.signal.aborted) return;
      if (result?.status === 'ok' && result.kind === 'callHierarchy') setAnswer(result);
      else setFailed(true);
      setChecking(false);
    });
    return () => operation.abort();
  }, [props.controller, item, direction]);
  const rows = React.useMemo(() => (answer?.calls ?? []).map(call => ({
    path: call.item.path,
    line: call.item.selectionRange.start.line,
    startCharacter: 0,
    endCharacter: call.item.name.length,
    lineText: call.item.name,
    outsideWorkspace: call.item.outsideWorkspace === true,
  })), [answer]);
  return (
    <View>
      <View style={styles.controls}>
        <SegmentedTabBar
          compact
          tabs={[
            { id: 'incoming', label: t('files.pane.intelligence.incomingCalls') },
            { id: 'outgoing', label: t('files.pane.intelligence.outgoingCalls') },
          ]}
          activeTabId={direction}
          onSelectTab={setDirection}
          testIDPrefix="code-call-direction"
        />
        {items && items.length > 1 ? (
          <SelectionTiles
            density="compact"
            accessibilityLabel={t('files.pane.intelligence.chooseCallTarget')}
            options={items.map(candidate => ({ id: JSON.stringify([candidate.serverId, candidate.itemId]),
              title: candidate.name, subtitle: `${candidate.path}:${candidate.selectionRange.start.line + 1}` }))}
            value={item ? JSON.stringify([item.serverId, item.itemId]) : null}
            onChange={id => setItem(items.find(candidate => JSON.stringify([candidate.serverId, candidate.itemId]) === id) ?? null)}
          />
        ) : null}
      </View>
      {failed ? (
        // The one shared inline notice (OWNER-UI-1115B A2): the failed lookup with Retry inline, on the list's edge.
        <View style={styles.controls}>
          <SurfaceStateCard
            testID="code-calls-failed"
            size="line"
            kind="error"
            title={t('files.pane.intelligence.noInfo')}
            accessibilitySemantics="alert"
            action={{ label: t('common.retry'), onPress: () => setRetry(value => value + 1), testID: 'code-calls-retry' }}
          />
        </View>
      ) : (
        <CodeReferencesList
          rows={rows}
          textMatches={false}
          partial={false}
          searching={checking}
          progress={null}
          emptyMessage={items && items.length > 1 && !item
            ? t('files.pane.intelligence.chooseCallTarget') : t('files.pane.intelligence.noCalls')}
          onOpen={props.onOpen}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create(theme => ({
  controls: { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8, gap: theme.space.s8 },
}));
