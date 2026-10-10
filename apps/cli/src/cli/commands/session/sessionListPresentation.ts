import { gray, yellow } from '@happier-dev/cli-common/output';
import { SessionAwarenessListResultV1Schema } from '@happier-dev/protocol/sessions/awareness/action';
import { SessionListResultSchema } from '@happier-dev/protocol/sessions/control/listResult';

import type { ActionCliPresentation } from '@/cli/actions/commandPresentation';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import type { CliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { renderSessionListTable } from '@/ui/renderSessionListTable';

function isAwarenessRequest(input: Readonly<Record<string, unknown>>): boolean {
  return input.view === 'awareness';
}

export function formatSessionListMetadataUpgradeNotice(count: number | undefined): string | null {
  return count !== undefined && count > 0
    ? 'Session list is incomplete: owners must upgrade shared Sessions before they can appear.'
    : null;
}

function warnIfMetadataUpgradeRequired(count: number | undefined): void {
  const notice = formatSessionListMetadataUpgradeNotice(count);
  if (notice) console.warn(yellow(notice));
}

function warnIfBotMetadataUnavailable(count: number | undefined): void {
  if (count !== undefined && count > 0) {
    console.warn(yellow('Session list is incomplete: authorized metadata is unavailable for the selected Bot filter.'));
  }
}

function isCliSessionRowModel(value: unknown): value is CliSessionRowModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<CliSessionRowModel>;
  return typeof row.id === 'string'
    && typeof row.createdAt === 'number'
    && typeof row.updatedAt === 'number'
    && typeof row.active === 'boolean'
    && typeof row.activeAt === 'number'
    && typeof row.isSystem === 'boolean'
    && (row.encryptionMode === 'plain' || row.encryptionMode === 'e2ee')
    && Boolean(row.vendorResume && typeof row.vendorResume === 'object');
}

export const SESSION_LIST_PRESENTATION: ActionCliPresentation = {
  envelopeKind: () => 'session_list',
  presentSuccess: async (payload, context) => {
    if (isAwarenessRequest(context.input)) {
      const awareness = SessionAwarenessListResultV1Schema.parse(payload);
      if (context.json) {
        await printJsonEnvelope({ ok: true, kind: 'session_list', data: awareness });
      } else {
        warnIfMetadataUpgradeRequired(awareness.metadataUpgradeRequiredCount);
        warnIfBotMetadataUnavailable(awareness.botFilterUnavailableCount);
        const plain = context.callerInput.plain === true;
        for (const session of awareness.sessions) {
          console.log(plain
            ? session.sessionId
            : `${session.sessionId}  ${session.title ?? ''}  ${session.operational.primary}  ${session.runtime}  ${session.freshness}`);
        }
      }
      return true;
    }

    const result = SessionListResultSchema.parse(payload);
    const sessions = result.sessions;
    const rows = Array.isArray(result.rows) && result.rows.every(isCliSessionRowModel)
      ? result.rows
      : [];
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_list',
        data: {
          sessions,
          nextCursor: result.nextCursor ?? null,
          hasNext: result.hasNext === true,
          ...(result.attentionNextCursor !== undefined ? { attentionNextCursor: result.attentionNextCursor } : {}),
          ...(result.attentionHasNext !== undefined ? { attentionHasNext: result.attentionHasNext } : {}),
          ...(result.queryVersion !== undefined ? { queryVersion: result.queryVersion } : {}),
          ...(result.metadataUpgradeRequiredCount !== undefined
            ? { metadataUpgradeRequiredCount: result.metadataUpgradeRequiredCount }
            : {}),
          ...(result.botFilterUnavailableCount !== undefined
            ? { botFilterUnavailableCount: result.botFilterUnavailableCount }
            : {}),
        },
      });
      return true;
    }

    warnIfMetadataUpgradeRequired(result.metadataUpgradeRequiredCount);
    warnIfBotMetadataUnavailable(result.botFilterUnavailableCount);
    if (context.callerInput.plain === true) {
      const includeSystem = context.callerInput.includeSystem === true;
      for (const row of rows) {
        const systemSuffix = includeSystem && row.isSystem
          ? ` ${yellow(`[system${row.systemPurpose ? `:${row.systemPurpose}` : ''}]`)}`
          : '';
        console.log(`${row.id}${systemSuffix}${row.tag ? ` ${gray(row.tag)}` : ''}${row.path ? ` ${gray(row.path)}` : ''}`);
      }
      if (rows.length === 0) {
        for (const session of sessions) console.log(session.id);
      }
      return true;
    }

    for (const line of renderSessionListTable({ rows })) console.log(line);
    return true;
  },
};
