import * as React from 'react';
import { presentActionFailure } from '@happier-dev/plugin-sdk/ui';
import { projectPluginActionRejectionV1 } from '@happier-dev/plugin-ui/hostApi';
import { Stack, usePluginHostApi, useSurfaceContext } from '@happier-dev/plugin-ui';
import {
  Button,
  HAPPIER_PAGE_METRICS,
  HappierPageSheet,
  HappierReviewSummary,
  HappierReviewSummaryHost,
  resolveHappierWorkTheme,
  usePluginTheme,
  usePluginTranslation,
  type HappierReviewSummaryHandle,
} from '@happier-dev/plugin-ui/components';
import { useTriageDetailReviewAnyway, useTriagePageRefresh } from '@happier-dev/triage-sources/ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';

type GithubReviewSkipV1 = NonNullable<TriageDetailSurfaceInputV1['reviewSkip']>;
type Translate = ReturnType<typeof usePluginTranslation>;

/**
 * The PR Overview's Review region: the latest skip Triage recorded for the observed head, then the admitted
 * Review it superseded, if any. An unbound PR opens no Review reader and draws nothing.
 */
export function GithubHappierReviewSummary({ reviewId, reviewSkip, draft }: Readonly<{
  reviewId?: string;
  reviewSkip?: GithubReviewSkipV1;
  draft?: boolean;
}>): React.ReactElement | null {
  const skip = reviewSkip?.reason === 'draft' && draft !== true ? undefined : reviewSkip;
  if (reviewId === undefined && skip === undefined) return null;
  return (
    <>
      {skip === undefined ? null : <SkippedReviewSummary skip={skip} />}
      {reviewId === undefined ? null : <AdmittedReviewSummary key={reviewId} reviewId={reviewId} />}
    </>
  );
}

function AdmittedReviewSummary({ reviewId }: Readonly<{ reviewId: string }>): React.ReactElement {
  const summary = React.useRef<HappierReviewSummaryHandle>(null);
  const refresh = React.useCallback(async () => { await summary.current?.refresh(); }, []);
  useTriagePageRefresh(refresh);
  return <HappierReviewSummaryHost ref={summary} reviewId={reviewId} />;
}

/**
 * Lab ideas-1118-reviews `rules/skipped`: the shared Review summary with the skip as its verdict and the
 * recorded reason as its one fact. Skipping is not a failure, so the sentence stays quiet. Review anyway is
 * the frame's own manual Review start; Edit the automation opens the Automation whose run asked.
 */
function SkippedReviewSummary({ skip }: Readonly<{ skip: GithubReviewSkipV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const { locale } = useSurfaceContext();
  const { palette } = resolveHappierWorkTheme(usePluginTheme());
  const reviewAnyway = useTriageDetailReviewAnyway();
  const automationId = skip.automationId;
  const editAutomation = React.useCallback(async () => {
    if (automationId === undefined) return;
    try { await host.openResource({ kind: 'automation', automationId }); }
    catch (error) {
      const failure = projectPluginActionRejectionV1(error, text);
      if (failure.status !== 'error' && failure.status !== 'outcomeUnknown') return;
      const presentation = await presentActionFailure(host, {
        ok: false, errorCode: failure.code, message: failure.message,
        ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      });
      await host.notify([presentation.reason, presentation.nextStep,
        ...presentation.technicalDetails.map(detail => `${detail.label}: ${detail.value}`)]
        .filter(Boolean).join('\n'), { severity: 'error' });
    }
  }, [automationId, host, text]);
  const actions = reviewAnyway === null && automationId === undefined ? undefined : (
    <>
      {reviewAnyway === null ? null : (
        <Button size="small" variant="secondary" onPress={reviewAnyway}
          title={text('plugins.github.ui.reviewSkip.reviewAnyway', 'Review anyway')} />
      )}
      {automationId === undefined ? null : (
        <Button size="small" variant="plain" onPress={() => { void editAutomation(); }}
          title={text('plugins.github.ui.reviewSkip.editAutomation', 'Edit the automation')} />
      )}
    </>
  );
  return (
    <HappierPageSheet colors={palette} rowDividers={false}>
      <Stack gap="small" style={{ paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
        paddingVertical: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx }}>
        <HappierReviewSummary heading={text('happier.plugin-ui.review.heading', 'Review')} subject={null}
          glance={{ sentence: text('plugins.github.ui.reviewSkip.title', 'Review skipped'), tone: 'quiet',
            facts: [describeReviewSkip(skip, text, locale)] }}
          rows={[]} reviewers="" actions={actions} />
      </Stack>
    </HappierPageSheet>
  );
}

/** The recorded reason in words, naming the rule field and where it was set; never a raw id. */
function describeReviewSkip(skip: GithubReviewSkipV1, text: Translate, locale: string): string {
  const { rules, occurrence } = skip;
  const source = (field: keyof GithubReviewSkipV1['rules']['provenance']) =>
    rules.provenance[field] === 'projectAutomation'
      ? text('plugins.github.ui.reviewSkip.source.projectAutomation', 'this automation')
      : text('plugins.github.ui.reviewSkip.source.baseCommit', 'the repository’s review rules');
  switch (skip.reason) {
    case 'baseRef': {
      const values = { patterns: formatDisjunction(rules.baseRefs ?? [], locale), source: source('baseRefs') };
      return occurrence.baseRef === undefined
        ? text('plugins.github.ui.reviewSkip.reason.baseRefUnknown', 'The base branch isn’t {patterns}, the branches reviewed under {source}.', values)
        : text('plugins.github.ui.reviewSkip.reason.baseRef', 'The base branch {base} isn’t {patterns}, the branches reviewed under {source}.',
          { ...values, base: occurrence.baseRef });
    }
    case 'authorKind': {
      const allowed = formatDisjunction((rules.authorKinds ?? []).map(kind => authorsWord(kind, text)), locale);
      const values = { allowed, source: source('authorKinds') };
      return occurrence.authorKind === undefined
        ? text('plugins.github.ui.reviewSkip.reason.authorKindUnknown', 'Only pull requests by {allowed} are reviewed under {source}.', values)
        : text('plugins.github.ui.reviewSkip.reason.authorKind', 'The author is {actual}, and only pull requests by {allowed} are reviewed under {source}.',
          { ...values, actual: authorWord(occurrence.authorKind, text) });
    }
    case 'draft':
      return text('plugins.github.ui.reviewSkip.reason.draft', 'It’s a draft, and drafts are skipped under {source}.', { source: source('skipDrafts') });
    case 'noReviewablePaths':
      return text('plugins.github.ui.reviewSkip.reason.noReviewablePaths', 'Every changed file matches a path ignored under {source}.',
        { source: source('ignorePaths') });
  }
}

type AuthorKind = NonNullable<GithubReviewSkipV1['occurrence']['authorKind']>;
function authorWord(kind: AuthorKind, text: Translate): string {
  switch (kind) {
    case 'human': return text('plugins.github.ui.reviewSkip.author.human', 'a person');
    case 'bot': return text('plugins.github.ui.reviewSkip.author.bot', 'a bot');
    case 'unsupported': return text('plugins.github.ui.reviewSkip.author.unsupported', 'an account Happier can’t classify');
  }
}
function authorsWord(kind: AuthorKind, text: Translate): string {
  switch (kind) {
    case 'human': return text('plugins.github.ui.reviewSkip.authors.human', 'people');
    case 'bot': return text('plugins.github.ui.reviewSkip.authors.bot', 'bots');
    case 'unsupported': return text('plugins.github.ui.reviewSkip.authors.unsupported', 'other accounts');
  }
}

/** "main or release/*" in the reader's locale where the runtime can say it; a plain list otherwise. */
function formatDisjunction(values: readonly string[], locale: string): string {
  const ListFormat = (Intl as { ListFormat?: new (locale?: string, options?: { type: 'disjunction' }) => { format(items: readonly string[]): string } }).ListFormat;
  return ListFormat === undefined ? values.join(', ') : new ListFormat(locale, { type: 'disjunction' }).format(values);
}
