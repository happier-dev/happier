import { ComposerSurfaceInputV1Schema } from '@happier-dev/plugin-sdk/ui';
import type { ComposerAttachmentViewV1, ComposerSurfaceInputV1 } from '@happier-dev/plugin-sdk/ui';
import type { ComposerRefV1 } from '@happier-dev/plugin-ui';

import {
    TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1,
    TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
} from './attachmentValue.js';

/**
 * The one address a mounted Triage Composer renderer may write to
 * (`core/COMPOSER.md` §3).
 *
 * A Composer mount arrives as a closed host-stamped launch input carrying the
 * exact scope this renderer was opened from. That input — not
 * `activeComposer()`, not a remembered handle, not "the composer that is
 * focused now" — is the address. With two live drafts the focused one is not
 * necessarily the one whose control opened this picker, and attaching to the
 * other is a silent defect the user discovers only after sending.
 *
 * The canonical Protocol schema is the sole parser. Triage adds no second
 * grammar for a host-owned value; it only decides which of the admitted mounts
 * belongs to this renderer.
 */

export type TriageComposerMountRefusalV1 =
    /** No launch input at all: an ordinary app-page or embedded mount. */
    | 'absent'
    /** Present, but not something the canonical composer-mount schema admits. */
    | 'invalidInput'
    /** A composer mount for a different renderer role. */
    | 'otherRole'
    /** This plugin's mount, but for a different contribution of it. */
    | 'otherContribution';

type TriageComposerPickerInputV1 = Extract<
    ComposerSurfaceInputV1,
    Readonly<{ role: 'attachmentPicker' }>
>;

export type TriageComposerPickerMountV1 =
    | Readonly<{
        status: 'bound';
        composer: ComposerRefV1;
        /**
         * The host's own view of this attachment's current instances at mount
         * time. It is a seed for the first frame only — the canonical snapshot
         * read through the bound handle is what the picker actually derives
         * selection from, so a stale mount input can never resurrect a removal.
         */
        instances: readonly ComposerAttachmentViewV1[];
    }>
    | Readonly<{ status: 'unbound'; reason: TriageComposerMountRefusalV1 }>;

/**
 * The control binding deliberately carries the composer ref and nothing else.
 *
 * The host also stamps its own `state` — label, count, selected — on this mount
 * input. The compact renderer does not read it: under the approved
 * attachment-derived compact state, zero/one/many comes from the canonical
 * attachment snapshot. Exposing the host's parallel count here would put a
 * second selection fact one autocomplete away from the renderer that must not
 * use it.
 */
export type TriageComposerControlMountV1 =
    | Readonly<{ status: 'bound'; composer: ComposerRefV1 }>
    | Readonly<{ status: 'unbound'; reason: TriageComposerMountRefusalV1 }>;

function unbound(reason: TriageComposerMountRefusalV1): Readonly<{
    status: 'unbound';
    reason: TriageComposerMountRefusalV1;
}> {
    return { status: 'unbound', reason };
}

function admitComposerMount(launchInput: unknown):
    | Readonly<{ status: 'admitted'; input: ComposerSurfaceInputV1 }>
    | Readonly<{ status: 'unbound'; reason: TriageComposerMountRefusalV1 }> {
    if (launchInput === undefined || launchInput === null) return unbound('absent');
    const parsed = ComposerSurfaceInputV1Schema.safeParse(launchInput);
    if (!parsed.success) return unbound('invalidInput');
    return { status: 'admitted', input: parsed.data };
}

/** The exact composer the admitted `entry` attachment picker was opened from. */
export function readTriageComposerPickerMount(launchInput: unknown): TriageComposerPickerMountV1 {
    const admitted = admitComposerMount(launchInput);
    if (admitted.status !== 'admitted') return admitted;

    const input = admitted.input;
    if (input.role !== 'attachmentPicker') return unbound('otherRole');
    const picker = input as TriageComposerPickerInputV1;
    if (picker.attachmentLocalId !== TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1) {
        return unbound('otherContribution');
    }
    return { status: 'bound', composer: picker.composer, instances: picker.instances };
}

/** The exact composer the admitted `entries` compact control renders for. */
export function readTriageComposerControlMount(launchInput: unknown): TriageComposerControlMountV1 {
    const admitted = admitComposerMount(launchInput);
    if (admitted.status !== 'admitted') return admitted;

    // `controlInteraction` shares this input arm and its composer scope, but it
    // is a different mount role with a different renderer contract; binding the
    // compact renderer to it would render the label in the wrong place. The two
    // roles share one arm, so this is a narrowing of the discriminant rather
    // than a selection of a distinct member.
    const control = admitted.input;
    if (control.role !== 'controlCompact') return unbound('otherRole');
    if (control.controlLocalId !== TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1) {
        return unbound('otherContribution');
    }
    return { status: 'bound', composer: control.composer };
}
