import type { BugReportArtifactPayload } from './types.js';
import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from './redaction.js';

function shouldIncludeBugReportArtifact(kind: string, acceptedKinds: readonly string[]): boolean {
  if (acceptedKinds.length === 0) return true;
  return acceptedKinds.includes(kind);
}

export function hasAcceptedBugReportArtifactKind(acceptedKinds: readonly string[], ...kinds: string[]): boolean {
  if (acceptedKinds.length === 0) return true;
  return kinds.some((kind) => acceptedKinds.includes(kind));
}

export function pushBugReportArtifact(
  list: BugReportArtifactPayload[],
  artifact: BugReportArtifactPayload,
  input: { maxArtifactBytes: number; acceptedKinds: string[] },
): void {
  if (!shouldIncludeBugReportArtifact(artifact.sourceKind, input.acceptedKinds)) return;
  const content = trimBugReportTextToMaxBytes(redactBugReportSensitiveText(artifact.content), input.maxArtifactBytes);
  if (!content.trim()) return;
  list.push({ ...artifact, content });
}
