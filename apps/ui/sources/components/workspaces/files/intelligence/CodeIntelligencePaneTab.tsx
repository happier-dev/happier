import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useCodeIntelligenceSnapshot } from '@/sync/domains/workspaces/languageIntelligence/useCodeIntelligence';
import { t } from '@/text';

import { CodeProblemsList } from './CodeProblemsList';
import type { CodeReferenceRow } from './CodeReferencesList';
import { CodeReferencesPanel } from './CodeReferencesPanel';
import {
  groupCodeProblems,
  isCodeReferenceResultPartial,
  resolveLanguageStateNote,
} from './codeIntelligencePresentation';
import { useCodeIntelligencePaneProducer } from './codeIntelligencePaneStore';

/**
 * The References and Problems tabs of a Session's or Project's right sidebar (LS1 L1 / L2). They read
 * the pane's active File page (its one controller); only the open tab subscribes to its answers.
 */
export function CodeIntelligencePaneTab(
  props: Readonly<{
    scopeId: string;
    kind: 'references' | 'problems';
    active: boolean;
  }>,
): React.ReactElement {
  const producer = useCodeIntelligencePaneProducer(props.scopeId);
  const snapshot = useCodeIntelligenceSnapshot(
    props.active ? (producer?.controller ?? null) : null,
  );
  const [selectedReference, setSelectedReference] =
    React.useState<CodeReferenceRow | null>(null);
  const [asked, setAsked] = React.useState(false);
  const [askBusy, setAskBusy] = React.useState(false);
  // The last Find references answer stays in the tab while the pointer asks about other names (LS1 L1).
  const lastReferences = React.useRef<
    Readonly<{ controller: unknown; snapshot: typeof snapshot }> | null
  >(null);
  if (snapshot.kind === 'references')
    lastReferences.current = { controller: producer?.controller, snapshot };
  const referencesSnapshot =
    lastReferences.current?.controller === producer?.controller
      ? (lastReferences.current?.snapshot ?? null)
      : null;
  const project = snapshot.problemsScope === 'project';
  const diagnosticsKey = project ? snapshot.projectDiagnostics?.items : snapshot.diagnostics?.items;
  React.useEffect(() => {
    setAsked(false);
  }, [diagnosticsKey, project]);
  if (!producer) {
    return (
      <View style={styles.empty}>
        <EmptyState
          layout="line"
          title={
            props.kind === 'references'
              ? t('files.pane.intelligence.referencesEmpty')
              : t('files.pane.intelligence.problemsEmpty')
          }
        />
      </View>
    );
  }
  const progress = resolveLanguageStateNote({
    snapshot,
    machineName: producer.machineName,
    machineUnreachable: producer.machineUnreachable,
  });
  const progressLine = progress?.kind === 'progress' ? progress : null;
  if (props.kind === 'references') {
    const answer = referencesSnapshot ?? snapshot;
    const result = answer.kind === 'references' ? answer.result : null;
    const rows: CodeReferenceRow[] =
      result && 'locations' in result
        ? result.locations.map((location) => ({
            path: location.path,
            line: location.range.start.line,
            startCharacter: location.range.start.character,
            endCharacter:
              location.range.end.line === location.range.start.line
                ? location.range.end.character
                : location.range.start.character,
            lineText: 'lineText' in location ? location.lineText : '',
          }))
        : [];
    if (answer.kind !== 'references') {
      return (
        <View style={styles.empty}>
          <EmptyState
            layout="line"
            title={t('files.pane.intelligence.referencesEmpty')}
          />
        </View>
      );
    }
    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        testID="code-references-pane"
      >
        <CodeReferencesPanel
          key={producer.path}
          controller={producer.controller}
          position={answer.querySelection?.position ?? null}
          supportsCalls={props.active && snapshot.capabilities?.callHierarchy === true}
          references={{
            rows,
            textMatches: answer.mode === 'fallback',
            partial: isCodeReferenceResultPartial(result),
            searching: snapshot.kind === 'references' && (snapshot.status === 'searching' || snapshot.status === 'loading'),
            progress: progressLine,
            selected: selectedReference,
            onOpen: (row) => {
              setSelectedReference(row);
              producer.openReference(row);
            },
          }}
        />
      </ScrollView>
    );
  }
  const diagnostics = project ? snapshot.projectDiagnostics : snapshot.diagnostics;
  const groups = diagnostics
    ? groupCodeProblems(diagnostics.items, snapshot.servers)
    : [];
  return (
    // The list owns its scroll so its Ask stays pinned at the panel foot (lab LS1 L2).
    <View style={styles.scroll} testID="code-problems-pane">
      <CodeProblemsList
        groups={groups}
        state={diagnostics?.state ?? 'idle'}
        count={diagnostics?.count ?? null}
        progress={project && snapshot.projectDiagnosticsReason === 'loading'
          ? { kind: 'progress', text: t('files.pane.intelligence.checking') } : progressLine}
        scope={snapshot.problemsScope ?? 'open'}
        onScopeChange={producer.controller.setProblemsScope}
        onCheckProject={producer.checkProjectProblems}
        onCancelProject={producer.controller.cancelProjectDiagnostics}
        projectChecking={snapshot.projectDiagnostics?.state === 'checking'}
        partial={project && snapshot.projectDiagnosticsPartial === true}
        onOpen={producer.openProblem}
        onCheck={producer.checkProblems}
        asked={asked}
        ask={
          producer.ask
            ? {
                label: producer.ask.label,
                busy: askBusy,
                onPress: () => {
                  setAskBusy(true);
                  void producer.ask
                    ?.run()
                    .then((created) => {
                      setAsked(created);
                    })
                    .finally(() => setAskBusy(false));
                },
              }
            : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    paddingTop: theme.space.s8,
  },
  empty: {
    paddingTop: theme.space.s8,
  },
}));
