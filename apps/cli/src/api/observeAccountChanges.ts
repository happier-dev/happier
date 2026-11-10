import { UpdateContainerSchema, type UpdateContainer } from '@happier-dev/protocol/updates';
import { ChangeKindSchema } from '@happier-dev/protocol/changes';
import { observeSessionSocketEvents } from '@/session/transport/socket/sessionSocketAgentState';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';

export type AccountChangeNotification = Extract<UpdateContainer['body'], {
  t: 'account-change' | 'new-artifact' | 'update-artifact' | 'delete-artifact';
}>;

/**
 * Demand-scoped observation over the incumbent Home socket. The wake is content-free;
 * readers fetch their exact durable facts. Reconnect invalidates those facts as well,
 * catching up missed writes without a second cursor or domain event stream.
 */
export function observeAccountChanges(
  opts: Readonly<{ token: string; serverUrl?: string; entityId?: string }>,
  handlers: Readonly<{ onChange: (change?: AccountChangeNotification) => void; onError: (error: unknown) => void }>,
): Readonly<{ dispose(): Promise<void> }> {
  return observeSessionSocketEvents({ token: opts.token, serverUrl: opts.serverUrl ?? resolveServerHttpBaseUrl(), scope: 'user' }, {
    onConnected: () => handlers.onChange(),
    onError: handlers.onError,
    onUpdate: (value) => {
      const parsed = UpdateContainerSchema.safeParse(value);
      if (!parsed.success) return;
      const body = parsed.data.body;
      if (body.t === 'account-change') {
        // Known commit hints select the reader's entity; absent or future hints
        // remain coarse so older/newer servers and reconnects still catch up.
        if (opts.entityId !== undefined && body.entityIds && body.changeKinds
          && body.changeKinds.every(kind => ChangeKindSchema.safeParse(kind).success)
          && !body.entityIds.includes(opts.entityId)) return;
        handlers.onChange(body);
      }
      else if ((body.t === 'new-artifact' || body.t === 'update-artifact' || body.t === 'delete-artifact')
        && (opts.entityId === undefined || body.artifactId === opts.entityId)) handlers.onChange(body);
    },
  });
}
