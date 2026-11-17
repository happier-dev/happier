import { PET_ANIMATION_STATES_V1 } from '../../../pets/constants.js';
import { HATCH_PET_STEP_IDS_V1, type HatchPetProgressV1 } from '../../../pets/hatchPetProgressV1.js';

// Each exhaustive record comes directly from its owning identifiers, including future additions.
const example: HatchPetProgressV1 = {
  kind: 'hatch_pet_progress_v1',
  petName: 'your pet',
  steps: Object.fromEntries(HATCH_PET_STEP_IDS_V1.map(id => [id, { status: 'pending' }])) as HatchPetProgressV1['steps'],
  poses: Object.fromEntries(PET_ANIMATION_STATES_V1.map(id => [id, { status: 'pending' }])) as HatchPetProgressV1['poses'],
};

/** Delivered beside the upstream guide; the existing command result is the progress carrier. */
export const HATCH_PET_PROGRESS_GUIDE_V1 = `# Happier hatch progress

Keep the ordinary four-step plan as the outline. Native plan/todo entries carry only their ordinary statuses: do not put pose metadata or failures into them and expect those fields to survive.

Read this guide before the first dependency check. Use the existing dependency-check, run-preparation, manifest-reading, pose-processing, and final-validation commands to publish progress. Append one compact JSON snapshot as the FINAL stdout line of each such command, after its ordinary output, including on failure before returning the command's actual nonzero exit code. Do not create a separate command/tool call just to publish progress, a progress file, an Artifact, or a new tool. The command result's existing stdout carries this line.

Start with this complete snapshot, replacing petName with the chosen name (or your pet until known):

\`\`\`json
${JSON.stringify(example)}
\`\`\`

Every snapshot includes every step and every pose shown above. Keep the latest known snapshot in the command you are composing and print its updated value; do not treat omitted entries as success. Step status is pending, in_progress, completed, or failed. Pose status is pending, drawing, drawn, or failed. A failed step or pose MUST instead have exactly {"status":"failed","failure":{"message":"the observed failure","details":"optional concrete diagnostic"}}. Other statuses have only status. JSON-escape names and diagnostics using the command language's JSON serializer.

For the first dependency command, gettingReady is in_progress while checking and preparing. If Python, Pillow, or WebP is missing, emit gettingReady failed with the observed dependency/interpreter diagnostic and leave later work pending, then explain the same failure in the transcript. When Python itself is unavailable, emit the escaped JSON through the available shell; installing Python is not part of this step.

Mark gettingReady completed only after the working inputs and run folder exist. On the next existing manifest/reference-processing command, mark mainLook in_progress before generating the main reference. Mark it completed only after its selected reference exists. Mark poses in_progress on the existing command that prepares its first generation job. Mark a pose drawing when that job is prepared; on the existing command that reads or processes its generation output, mark it drawn only after the selected row really exists. A mirrored row counts only after the upstream mirror policy has been satisfied and that row exists. Publish the full updated snapshot whenever these commands observe a new pose result. A failed generation or row validation marks the affected pose and poses step failed with the actual diagnostic; retain all other observed statuses. After a generation error, still inspect the existing manifest and available outputs in the ordinary output-inspection command and emit that failure there. A repair may move that failed pose back to drawing and later drawn when real replacement work succeeds. Never fabricate a drawn count: Happier derives it from the ${PET_ANIMATION_STATES_V1.length} pose statuses.

If main-reference generation fails, inspect its manifest and available outputs through the ordinary output-inspection command, mark mainLook failed with the observed diagnostic, and leave unstarted poses pending. The same rule applies to a working-input or run-preparation failure: gettingReady fails with its concrete diagnostic, without marking later work complete.

On the existing final packaging/validation command, mark hatching in_progress; mark it completed only when final files and required checks succeed. If packaging or validation fails, mark hatching failed with its diagnostic. Emit the final snapshot before requesting pet.import. The ordinary pet.import confirmation supplies the preview and the person's Add approval; do not bypass it or claim the pet was added before its approved Action succeeds.
`;
