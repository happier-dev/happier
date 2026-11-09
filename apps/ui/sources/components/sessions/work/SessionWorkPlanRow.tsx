import * as React from 'react';
import {
  SessionPromptStackV1StoredSchema,
  type SessionPromptStackEntryV1,
} from '@happier-dev/protocol/sessions/context/sessionContextV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  promptStackEntryHref,
  usePromptStackEntryPresentations,
} from '@/components/settings/prompts/stacks/promptStackEntryPresentation';
import { Item } from '@/components/ui/lists/Item';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useArtifact, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useSessionSelector } from '@/sync/store/hooks';
import { t } from '@/text';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

/** The Session Context Doc marked as its plan (`work.promptStack`, `plan: true`), as a primitive signature. */
function readPlanEntryJson(metadata: unknown): string | null {
  const stack = SessionPromptStackV1StoredSchema.safeParse(
    field(field(metadata, 'work'), 'promptStack') ?? [],
  );
  const plan = stack.success
    ? stack.data.find((entry) => entry.plan === true)
    : undefined;
  return plan ? JSON.stringify(plan) : null;
}

/**
 * Work's Plan row (C1 Z17): the Doc this Session marked as its plan — its title and last edit, and it
 * opens the Doc. Marking happens on the Context row (Info); the plan holds no status. Nothing is drawn
 * while no Doc is marked.
 */
export function SessionWorkPlanRow(
  props: Readonly<{ sessionId: string; serverId: string | null }>,
) {
  const planJson = useSessionSelector(
    props.sessionId,
    props.serverId,
    (session) =>
      session ? readPlanEntryJson(readSessionOwnerMetadataView(session)) : null,
  );
  if (!planJson || !props.serverId) return null;
  return <PlanRow entryJson={planJson} serverId={props.serverId} />;
}

function PlanRow(props: Readonly<{ entryJson: string; serverId: string }>) {
  const router = useRouter();
  const entry = React.useMemo(
    () => JSON.parse(props.entryJson) as SessionPromptStackEntryV1,
    [props.entryJson],
  );
  const entries = React.useMemo(() => [entry], [entry]);
  const presentations = usePromptStackEntryPresentations(
    entries,
    props.serverId,
  );
  const presentation = presentations(entry);
  const status = presentations.status(entry);
  const scope = useActiveServerAccountScope(entry.ref.serverId ?? props.serverId);
  const artifact = useArtifact(scope ? entry.ref.artifactId : '');
  const updatedAt = artifact?.draft ? null : artifact?.updatedAt ?? null;
  const href = promptStackEntryHref(entry, presentation.kind, props.serverId);
  const title =
    presentation.title ??
    (status === 'unavailable'
      ? t('common.unavailable')
      : t('promptLibrary.untitledPrompt'));
  const detail = updatedAt
    ? `${title} · ${formatRelativeTimeShort(updatedAt, Date.now())}`
    : title;
  return (
    <Item
      testID="session-work-plan"
      title={t('sessionWork.plan')}
      detail={detail}
      loading={status === 'loading'}
      density="compact"
      onPress={href ? () => router.push(href as never) : undefined}
      mode={href ? 'interactive' : 'info'}
      showChevron={href !== null}
    />
  );
}
