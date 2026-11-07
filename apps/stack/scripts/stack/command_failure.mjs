import { emitSourceStartSuperseded } from '../runtime/shared/pending_source_start.mjs';

export function reportStackCommandFailure(error, message = error instanceof Error ? error.message : String(error)) {
  emitSourceStartSuperseded(error);
  console.error('[stack] failed:', message);
  if (process.env.DEBUG && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
