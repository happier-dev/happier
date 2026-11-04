import type { ActionExecutorContext } from '../../actions/executor/types.js';
import type { ArtifactTemplateAcceptedVersionInputV1 } from '../../artifacts/artifactAccessV1.js';
import type { BotTemplateInstanceV1 } from './templateInstanceV1.js';

export type BotTemplateAcceptedVersionReporterV1 = Readonly<{
  reportAcceptedVersion?(input: ArtifactTemplateAcceptedVersionInputV1, context: ActionExecutorContext): Promise<void>;
}>;

/** Successful copy/update settlement alone invokes this best-effort sharing projection.
 * One-time link copies without a grant omit the invocation; following is an independent preference. */
export async function bestEffortReportBotTemplateAcceptedVersionV1(port: BotTemplateAcceptedVersionReporterV1,
  input: Readonly<{ instance: BotTemplateInstanceV1; copyId: string }>, context: ActionExecutorContext): Promise<void> {
  if (input.instance.source.kind !== 'artifact' || !port.reportAcceptedVersion) return;
  try {
    await port.reportAcceptedVersion({ artifactId: input.instance.source.artifactId, copyId: input.copyId,
      acceptedVersion: input.instance.acceptedVersion }, context);
  } catch {
    // Author status is explicitly last-reported: transport failure never changes content settlement.
  }
}
