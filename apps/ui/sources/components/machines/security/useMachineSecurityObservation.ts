import { useMachineUpdates, type UseMachineUpdatesInput } from './useMachineUpdates';

export function useMachineSecurityObservation(input: UseMachineUpdatesInput) {
  const updates = useMachineUpdates(input, true);
  const { projection, failure, refresh } = updates;
  const status = input.reachable === false ? 'offline'
    : projection ? 'ready'
    : failure ? 'failed'
    : updates.read.kind === 'settled' ? 'unsupported' : 'reading';
  return { projection, updates, status, failure, refresh };
}
