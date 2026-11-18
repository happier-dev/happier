import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { readPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { t } from '@/text';
import type { PromptDocUpdateApproval } from './promptDocApprovalModel';
import { PROMPT_DOC_WRITE_RESULT_KEY } from './promptDocWriteResultCopy';
export { readPromptDocUpdateApproval, type PromptDocUpdateApproval } from './promptDocApprovalModel';

const PROSE_INLINE = { inline: true } as const;

type CurrentDocument =
  | Readonly<{ status: 'loading' }>
  | Readonly<{
      status: 'ready';
      markdown: string;
      revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
    }>
  | Readonly<{ status: 'unavailable' }>;

/**
 * The Agent's proposed instructions edit as a diff against the document as it is now (plan 61, lab
 * `b-work P`): instructions are read, not code, so it is the diff viewer's prose face in one column —
 * context lines quiet, the change marked where it happens. When the document changed after the edit was
 * reviewed, the card says so — approving would be refused by the reviewed-revision check, never
 * silently rebased. When it applies is said once beneath.
 */
export const PromptDocApprovalDiff = React.memo(function PromptDocApprovalDiff(
  props: Readonly<{
    request: PromptDocUpdateApproval;
    serverId: string | null;
    testID?: string;
  }>,
): React.ReactElement {
  const styles = stylesheet;
  const { artifactId } = props.request;
  const [current, setCurrent] = React.useState<CurrentDocument>({
    status: 'loading',
  });
  const [readAttempt, setReadAttempt] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setCurrent({ status: 'loading' });
    void (async () => {
      try {
        const result = await withUiPromptLibraryArtifactReader(
          (reader) =>
            readPromptDocInLibrary({
              artifactId,
              store: {
                read: () =>
                  reader.readArtifact({
                    kind: 'doc',
                    artifactId,
                    ...(props.serverId ? { serverId: props.serverId } : {}),
                  }),
              },
              signal: controller.signal,
            }),
          { serverId: props.serverId, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setCurrent(
          result.ok
            ? {
                status: 'ready',
                markdown: result.markdown,
                revision: result.revision,
              }
            : { status: 'unavailable' },
        );
      } catch {
        if (!controller.signal.aborted) setCurrent({ status: 'unavailable' });
      }
    })();
    return () => controller.abort();
  }, [artifactId, props.serverId, readAttempt]);
  const testID = props.testID ?? 'prompt-doc-approval-diff';
  const reviewed = props.request.expectedRevision;
  // A decided edit reads as its outcome. Only a still-pending review can be stale against a newer body:
  // an executed write's own newer revision is the result, not a conflict.
  const outcome = props.request.outcome?.status ?? 'pending';
  const settled = outcome !== 'pending';
  const changedSinceReview =
    !settled &&
    current.status === 'ready' &&
    reviewed !== null &&
    (reviewed.headerVersion !== current.revision.headerVersion ||
      reviewed.bodyVersion !== current.revision.bodyVersion);
  return (
    <View testID={testID} style={styles.container}>
      {changedSinceReview ? (
        <Text testID={`${testID}.conflict`} style={styles.conflict}>
          {t('sessionInstructions.saveConflict')}
        </Text>
      ) : null}
      {current.status === 'ready' ? (
        <DiffViewer
          mode="text"
          face="prose"
          prose={PROSE_INLINE}
          testID={`${testID}.lines`}
          oldText={current.markdown}
          newText={props.request.markdown}
        />
      ) : current.status === 'loading' ? (
        <Text style={styles.quiet}>{t('sessionInstructions.loading')}</Text>
      ) : (
        <SurfaceStateCard
          testID={`${testID}.unavailable`}
          kind="error"
          size="line"
          title={t('artifacts.browser.loadFailedTitle')}
          reason={t('artifacts.browser.loadFailedBody')}
          action={{ label: t('common.retry'), onPress: () => setReadAttempt(attempt => attempt + 1) }}
        />
      )}
      {settled ? (
        <Text
          testID={`${testID}.outcome.${outcome}`}
          style={outcome === 'conflict' || outcome === 'failed' ? styles.conflict : styles.quiet}
        >
          {t(PROMPT_DOC_WRITE_RESULT_KEY[outcome])}
        </Text>
      ) : null}
      {!settled || outcome === 'updated' ? (
        <Text style={styles.quiet}>{t('sessionInstructions.nextBoundary')}</Text>
      ) : null}
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  container: { gap: theme.space.s8 },
  conflict: {
    ...Typography.variant('meta'),
    color: theme.colors.state.warning.textForeground,
  },
  quiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
