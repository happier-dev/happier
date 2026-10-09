import * as React from 'react';
import type { ToolCall } from '@happier-dev/session-core/messages';

import { ProjectCommandOutputPane } from '@/components/inbox/actionOperations/ProjectCommandOutputPane';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import {
  readTranscriptProjectCommandAcceptance,
  type TranscriptProjectCommandCall,
} from '@/components/sessions/transcript/references/transcriptProjectCommandReference';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';

/**
 * The expanded body of an agent's finite Project command or its `wait` (lab `s-agent` CARD): the run's
 * own retained output, borrowed read-only from its actual target, with the operation detail (target, Stop)
 * one tap away. Until the operation is known on this client the ordinary tool body stays.
 */
export const ProjectCommandToolBody = React.memo(
  function ProjectCommandToolBody(
    props: Readonly<{
      tool: Pick<ToolCall, 'name' | 'input' | 'state' | 'result'>;
      call: TranscriptProjectCommandCall;
      serverId: string | null | undefined;
      fallback: React.ReactElement | null;
    }>,
  ) {
    const { call, tool } = props;
    const acceptance = React.useMemo(
      () =>
        call.kind === 'start'
          ? readTranscriptProjectCommandAcceptance(tool)
          : null,
      [call.kind, tool],
    );
    const operationId =
      call.kind === 'wait'
        ? call.operationId
        : (acceptance?.operationId ?? null);
    const serverId = operationId ? (props.serverId ?? null) : null;
    const operation = useActionOperation({
      serverId,
      operationId: operationId ?? '',
    });
    const openDetail = React.useCallback(() => {
      if (serverId && operationId)
        openActionOperationDetail({ serverId, operationId });
    }, [operationId, serverId]);
    if (!operation || operation.snapshot.domainRef?.kind !== 'projectCommand')
      return props.fallback;
    const attachment = operation.snapshot.domainRef;
    return (
      <ProjectCommandOutputPane
        operation={operation}
        title={attachment.script?.name ?? operation.snapshot.title}
        height={160}
        onOpenDetail={openDetail}
      />
    );
  },
);
