import * as React from 'react';
import type { ReactElement } from 'react';
import {
  Banner,
  Button,
  FreshnessLine,
  Row,
  SurfaceState,
  Text,
  usePluginHostApi,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { ForgeOperationStateV1 } from '../operationState.js';

/**
 * Who the notice speaks for. The forge and account names come from the host binding (the forge plugin knows them),
 * so this shared composition never spells a vendor itself.
 */
export type ForgeCiStateSubjectV1 = Readonly<{
  /** The forge's display name ("GitHub"). */
  forgeName: string;
  /** The exact account's display name ("leeroybrun"), when the host knows it. */
  accountLabel?: string | null;
  /** The Machine that holds the forge sign-in, for offline copy ("devbox"). */
  machineLabel?: string | null;
  /** What this surface lists, for a failed first read ("runs", "this run", "the jobs"). */
  subject: string;
}>;

export type ForgeCiStateNoticeProps = Readonly<{
  state: ForgeOperationStateV1;
  about: ForgeCiStateSubjectV1;
  /**
   * `surface`: nothing is retained, the notice is the whole pane or page body. `line`: retained content stays
   * below at full strength and the notice is one freshness line above it. `banner`: a write surface (trigger form,
   * run controls) whose action could not complete.
   */
  presentation: 'surface' | 'line' | 'banner';
  /** When the retained facts were read, for the `As of` line. */
  asOfMs?: number | null;
  onRetry?: () => unknown;
  /** The safe status read after an unknown write. It never resends the write. */
  onCheckStatus?: () => unknown;
  checking?: boolean;
  testID?: string;
}>;

function rateLimitCopy(
  t: ReturnType<typeof usePluginTranslation>,
  failure: TriageSourceFailureV1,
  about: ForgeCiStateSubjectV1,
) {
  const who = about.accountLabel ?? about.forgeName;
  // Retry eligibility is not necessarily a bucket reset or automatic liveness.
  if (failure.retryNotBeforeMs !== undefined) {
    const at = new Intl.DateTimeFormat(undefined, {
      timeStyle: 'short',
    }).format(new Date(failure.retryNotBeforeMs));
    return {
      title: t('forgeCi.state.rateLimited.title', '{forge} request limit', {
        forge: about.forgeName,
      }),
      body: t(
        'forgeCi.state.rateLimited.reset',
        '{forge} is limiting requests from {who}. Requests can resume after {time}.',
        { forge: about.forgeName, who, time: at },
      ),
    };
  }
  return {
    title: t('forgeCi.state.rateLimited.waitingTitle', 'Waiting on {forge}', {
      forge: about.forgeName,
    }),
    body: t(
      'forgeCi.state.rateLimited.waiting',
      '{forge} is limiting requests from {who}. Try again when the limit has eased.',
      { forge: about.forgeName, who },
    ),
  };
}

function failureCopy(
  t: ReturnType<typeof usePluginTranslation>,
  failure: TriageSourceFailureV1,
  about: ForgeCiStateSubjectV1,
) {
  // The host's canonical current-intent refusal is a person's decision,
  // independent of the credential's permission to read or write.
  if (failure.code === 'plugin_action_current_intent_rejected') return {
    kind: 'denied' as const,
    title: t('forgeCi.state.declined.title', 'Not done'),
    body: t('forgeCi.state.declined.body', 'You declined the confirmation. Nothing on {forge} was changed.', { forge: about.forgeName }),
  };
  if (failure.code === 'ci_execution_unavailable') return {
    kind: 'unavailable' as const,
    title: t('forgeCi.state.executionUnavailable.title', '{forge} Actions unavailable', { forge: about.forgeName }),
    body: t('forgeCi.state.executionUnavailable.body', 'This project’s Machine can’t run {forge} Actions right now. Nothing on {forge} was changed.', { forge: about.forgeName }),
  };
  switch (failure.class) {
    case 'rateLimit':
      return { kind: 'warning' as const, ...rateLimitCopy(t, failure, about) };
    case 'permission':
      return {
        kind: 'denied' as const,
        title: t(
          'forgeCi.state.permission.title',
          'Your {forge} sign-in can’t read this',
          { forge: about.forgeName },
        ),
        body: t(
          'forgeCi.state.permission.body',
          'The sign-in for {who} has no access to {subject} here. Add access to it on {forge}, or use another sign-in.',
          {
            who: about.accountLabel ?? about.forgeName,
            subject: about.subject,
            forge: about.forgeName,
          },
        ),
      };
    case 'transient':
      return about.machineLabel
        ? {
            kind: 'unavailable' as const,
            title: t(
              'forgeCi.state.offline.title',
              '{machine} isn’t answering',
              { machine: about.machineLabel },
            ),
            body: t(
              'forgeCi.state.offline.body',
              '{machine} holds this project’s {forge} sign-in. Reading, starting and re-running wait for it.',
              {
                machine: about.machineLabel,
                forge: about.forgeName,
              },
            ),
          }
        : {
            kind: 'error' as const,
            title: t('forgeCi.state.error.title', 'Couldn’t load {subject}', {
              subject: about.subject,
            }),
            body: t(
              'forgeCi.state.error.transient',
              '{forge} didn’t answer. Nothing on {forge} was changed.',
              { forge: about.forgeName },
            ),
          };
    default:
      return {
        kind: 'error' as const,
        title: t('forgeCi.state.error.title', 'Couldn’t load {subject}', {
          subject: about.subject,
        }),
        body: t(
          'forgeCi.state.error.body',
          '{forge} answered with an error. Nothing on {forge} was changed.',
          { forge: about.forgeName },
        ),
      };
  }
}

/**
 * The shared CI states (plans 02 §6, 03 §4): expired sign-in, a write whose answer was lost, rate limits, missing
 * permission, an offline Machine and a failed read. One cause, one line, one next action, at the level that owns it;
 * a page, a pane and the rail draw the same words at their own size.
 */
export function ForgeCiStateNotice({
  state,
  about,
  presentation,
  asOfMs,
  onRetry,
  onCheckStatus,
  checking,
  testID,
}: ForgeCiStateNoticeProps): ReactElement | null {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  if (state.kind === 'ready') return null;

  if (state.kind === 'credentials-expired') {
    const who = about.accountLabel ?? null;
    const repair = () =>
      host.openConnectedAccounts({
        service: state.account.service,
        accountId: state.account.accountId,
      });
    const label = t('forgeCi.state.signInAgain', 'Sign in again');
    if (presentation === 'line') {
      return (
        <FreshnessLine
          asOf={asOfMs ?? null}
          tone="warning"
          reason={
            who
              ? t(
                  'forgeCi.state.expired.line',
                  'The {forge} sign-in for {who} expired. Everything here stays; sign in again to refresh it.',
                  { forge: about.forgeName, who },
                )
              : t(
                  'forgeCi.state.expired.lineAnon',
                  'The {forge} sign-in expired. Everything here stays; sign in again to refresh it.',
                  { forge: about.forgeName },
                )
          }
          action={{
            label,
            onPress: () => {
              void repair();
            },
          }}
          {...(testID === undefined ? {} : { testID })}
        />
      );
    }
    if (presentation === 'banner') {
      return (
        <Banner
          tone="attention"
          title={
            who
              ? t(
                  'forgeCi.state.expired.bannerTitle',
                  'Sign in again as {who}',
                  { who },
                )
              : t(
                  'forgeCi.state.expired.bannerTitleAnon',
                  'Sign in to {forge} again',
                  { forge: about.forgeName },
                )
          }
          description={t(
            'forgeCi.state.expired.bannerBody',
            'The sign-in expired before this was sent. Nothing reached {forge}, and your inputs stay as they are.',
            { forge: about.forgeName },
          )}
          action={
            <Button
              title={label}
              variant="primary"
              size="small"
              onPress={() => {
                void repair();
              }}
            />
          }
          {...(testID === undefined ? {} : { testID })}
        />
      );
    }
    return (
      <SurfaceState
        kind="denied"
        title={t('forgeCi.state.expired.title', 'Sign in to {forge} again', {
          forge: about.forgeName,
        })}
        description={
          who
            ? t(
                'forgeCi.state.expired.body',
                'The sign-in for {who} expired or was revoked. Sign in again as the same account and this comes back as you left it.',
                { who },
              )
            : t(
                'forgeCi.state.expired.bodyAnon',
                'The sign-in expired or was revoked. Sign in again as the same account and this comes back as you left it.',
              )
        }
        action={{ label, onPress: repair }}
        {...(who
          ? {
              note: t(
                'forgeCi.state.expired.note',
                'Only {who} is affected. Other accounts and projects keep working.',
                { who },
              ),
            }
          : {})}
        {...(testID === undefined ? {} : { testID })}
      />
    );
  }

  if (state.kind === 'uncertain-write-outcome') {
    const targetUrl = state.targetUrl;
    return (
      <Banner
        tone="attention"
        title={t(
          'forgeCi.state.unknown.title',
          'Result unknown — check on {forge}',
          { forge: about.forgeName },
        )}
        description={t(
          'forgeCi.state.unknown.body',
          'Happier sent this to {forge}, but the answer never arrived, so it may or may not have happened. Happier won’t send it again on its own.',
          { forge: about.forgeName },
        )}
        action={
          <Row gap="small" wrap>
            {onCheckStatus ? (
              <Button
                title={t('forgeCi.state.unknown.check', 'Check status')}
                variant="secondary"
                size="small"
                busy={checking === true}
                onPress={onCheckStatus}
              />
            ) : null}
            {targetUrl ? (
              <Button
                title={t('forgeCi.state.openOn', 'Open on {forge}', {
                  forge: about.forgeName,
                })}
                variant="plain"
                size="small"
                onPress={() => {
                  void host.openExternalLink(targetUrl);
                }}
              />
            ) : null}
          </Row>
        }
        {...(testID === undefined ? {} : { testID })}
      />
    );
  }

  const copy = failureCopy(t, state.failure, about);
  if (presentation === 'line' || state.stale) {
    return (
      <FreshnessLine
        asOf={asOfMs ?? null}
        tone="warning"
        reason={copy.body}
        {...(onRetry
          ? {
              action: {
                label: t('forgeCi.state.retry', 'Retry'),
                onPress: () => {
                  void onRetry();
                },
              },
            }
          : {})}
        {...(testID === undefined ? {} : { testID })}
      />
    );
  }
  if (presentation === 'banner') {
    return (
      <Banner
        tone={copy.kind === 'warning' ? 'warning' : 'danger'}
        title={copy.title}
        description={copy.body}
        {...(testID === undefined ? {} : { testID })}
      />
    );
  }
  return (
    <SurfaceState
      kind={copy.kind}
      title={copy.title}
      description={copy.body}
      {...(onRetry &&
      state.failure.class !== 'permission'
        ? {
            action: {
              label: t('forgeCi.state.tryAgain', 'Try again'),
              onPress: onRetry,
            },
          }
        : {})}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}

/** The quiet `Text` a compact host (rail, widget) shows when it has no room for a whole notice. */
export function ForgeCiStateWord({
  state,
  about,
}: Readonly<{
  state: ForgeOperationStateV1;
  about: ForgeCiStateSubjectV1;
}>): ReactElement | null {
  const t = usePluginTranslation();
  if (state.kind === 'ready') return null;
  const value =
    state.kind === 'credentials-expired'
      ? t('forgeCi.state.expired.short', '{forge} sign-in expired', {
          forge: about.forgeName,
        })
      : state.kind === 'uncertain-write-outcome'
        ? t('forgeCi.state.unknown.short', 'Result unknown')
        : state.failure.class === 'rateLimit'
          ? t('forgeCi.state.rateLimited.short', 'Waiting on {forge}', {
              forge: about.forgeName,
            })
          : t('forgeCi.state.error.short', 'Couldn’t load');
  return (
    <Text
      variant="meta"
      tone={
        state.kind === 'failure' && state.failure.class !== 'rateLimit'
          ? 'danger'
          : 'attention'
      }
      value={value}
    />
  );
}
