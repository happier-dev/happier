import type { RequesterSessionRuntimeContext } from './requesterSessionCredentials';

const operationReferences = new WeakMap<RequesterSessionRuntimeContext, number>();

/** An admitted operation may finish after its runner releases the same Account. */
export function retainRequesterSessionRuntimeContext(context: RequesterSessionRuntimeContext): () => void {
  operationReferences.set(context, (operationReferences.get(context) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = operationReferences.get(context)! - 1;
    if (remaining === 0) operationReferences.delete(context);
    else operationReferences.set(context, remaining);
  };
}

/** Tracked runners and scoped operations share the requester's existing lifetime. */
export async function releaseUnretainedRequesterSessionRuntimeContext(
  context: RequesterSessionRuntimeContext,
  retainedContexts: Iterable<RequesterSessionRuntimeContext | null | undefined>,
): Promise<void> {
  if (operationReferences.has(context)) return;
  for (const retained of retainedContexts) if (retained === context) return;
  await context.dispose();
}
