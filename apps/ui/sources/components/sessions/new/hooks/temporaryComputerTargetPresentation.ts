import type { SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import {
    RUNNER_ARTIFACT_TARGETS,
    runnerArtifactTargetPlatform,
    type RunnerArtifactTarget,
} from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';

import { t } from '@/text';

/**
 * The one place a published Runner artifact target becomes something a person
 * can read.
 *
 * Before this existed the picker printed the raw wire value — a row literally
 * titled `darwin-arm64` — while the composer's destination chip still said
 * "Select machine" for a destination the draft had already committed. Both are
 * the same missing fact: an execution target has no human name unless one owner
 * gives it one. Nothing stores that name; it is derived from the target every
 * time, so a draft can never carry a label that disagrees with what will run.
 */

function isKnownArtifactTarget(value: string): value is RunnerArtifactTarget {
    return (RUNNER_ARTIFACT_TARGETS as readonly string[]).includes(value);
}

/**
 * "macOS · Apple silicon" for a target this client knows.
 *
 * A target it does not know is not an error: a newer Home may publish a platform
 * this build has never heard of, and the honest answer is that the platform is
 * unrecognized — never the raw identifier, and never a guess.
 */
export function describeRunnerArtifactTarget(target: string | null | undefined): string {
    if (typeof target !== 'string' || !isKnownArtifactTarget(target)) {
        return t('newSession.temporaryComputer.platform.unknown');
    }
    return t(`newSession.temporaryComputer.platform.${target}` as Parameters<typeof t>[0]);
}

/**
 * The destination name for a committed Temporary-computer target, e.g.
 * "Temporary Mac computer". Falls back to the plain product name rather than
 * inventing a platform for a target this build cannot recognize.
 */
export function describeTemporaryComputerDestination(
    target: Extract<SessionAuthoringExecutionTargetV2, { kind: 'temporary_computer' }>,
): string {
    if (!isKnownArtifactTarget(target.artifactTarget)) {
        return t('newSession.temporaryComputer.title');
    }
    const { os } = runnerArtifactTargetPlatform(target.artifactTarget);
    return t(`newSession.temporaryComputer.destination.${os}` as Parameters<typeof t>[0]);
}

/**
 * The composer chip label for whatever the draft currently targets, or `null`
 * when the exact-Machine owner still names the destination.
 */
export function describeExecutionTargetDestination(
    target: SessionAuthoringExecutionTargetV2 | null | undefined,
): string | null {
    return target?.kind === 'temporary_computer' ? describeTemporaryComputerDestination(target) : null;
}
