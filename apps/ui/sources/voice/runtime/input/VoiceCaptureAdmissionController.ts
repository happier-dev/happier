export type VoiceCaptureProductOwner = 'conversation' | 'dictation';

export type VoiceCaptureAdmissionLease = Readonly<{
    owner: VoiceCaptureProductOwner;
    release: () => void;
}>;

export type VoiceCaptureAdmissionResult =
    | Readonly<{
        status: 'acquired';
        lease: VoiceCaptureAdmissionLease;
    }>
    | Readonly<{
        status: 'busy';
        activeOwner: VoiceCaptureProductOwner;
    }>;

export type VoiceCaptureAdmissionController = Readonly<{
    acquire: (owner: VoiceCaptureProductOwner) => VoiceCaptureAdmissionResult;
}>;

export class VoiceCaptureBusyError extends Error {
    readonly activeOwner: VoiceCaptureProductOwner;
    readonly code: `voice_capture_busy_${VoiceCaptureProductOwner}`;

    constructor(activeOwner: VoiceCaptureProductOwner) {
        const code = `voice_capture_busy_${activeOwner}` as const;
        super(code);
        this.name = 'VoiceCaptureBusyError';
        this.activeOwner = activeOwner;
        this.code = code;
    }
}

/**
 * Product-level admission for microphone-consuming Voice operations.
 *
 * This controller decides whether conversational Voice or Dictation owns the
 * current utterance. Native audio-session and capture coordination remains at
 * the platform owner below this boundary.
 */
export function createVoiceCaptureAdmissionController(): VoiceCaptureAdmissionController {
    let active: Readonly<{ owner: VoiceCaptureProductOwner }> | null = null;

    return {
        acquire: (owner) => {
            if (active) {
                return {
                    status: 'busy',
                    activeOwner: active.owner,
                };
            }

            const admission = Object.freeze({ owner });
            active = admission;
            let released = false;

            return {
                status: 'acquired',
                lease: {
                    owner,
                    release: () => {
                        if (released) return;
                        released = true;
                        if (active === admission) {
                            active = null;
                        }
                    },
                },
            };
        },
    };
}

export const voiceCaptureAdmissionController =
    createVoiceCaptureAdmissionController();
