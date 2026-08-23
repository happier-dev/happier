import {
  ActionOperationProgressV1Schema,
  type ActionOperationProgressV1,
} from '@happier-dev/protocol';

/** Keeps progress validation at the operation owner before a snapshot revision is accepted. */
export function parseActionOperationProgress(
  value: unknown,
): ActionOperationProgressV1 | null {
  const parsed = ActionOperationProgressV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
