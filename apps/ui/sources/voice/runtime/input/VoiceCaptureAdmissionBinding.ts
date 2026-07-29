import type { LocalVoiceCaptureOwner } from './LocalVoiceCaptureOwner';
import type {
    VoiceCaptureAdmissionController,
    VoiceCaptureAdmissionLease,
    VoiceCaptureProductOwner,
} from './VoiceCaptureAdmissionController';
import { VoiceCaptureBusyError } from './VoiceCaptureAdmissionController';

export { VoiceCaptureBusyError } from './VoiceCaptureAdmissionController';

type CaptureOwner = Pick<
    LocalVoiceCaptureOwner,
    'startCapture' | 'stopCapture' | 'stopSession'
>;

export type VoiceCaptureAdmissionBinding = CaptureOwner & Readonly<{
    releaseAdmission: (sessionId?: string | null) => void;
}>;

export function createVoiceCaptureAdmissionBinding(input: Readonly<{
    admission: VoiceCaptureAdmissionController;
    captureOwner: CaptureOwner;
    productOwner: VoiceCaptureProductOwner;
}>): VoiceCaptureAdmissionBinding {
    let active: Readonly<{
        sessionId: string;
        lease: VoiceCaptureAdmissionLease;
    }> | null = null;

    const releaseAdmission = (sessionId?: string | null): void => {
        const admission = active;
        if (!admission) return;
        if (sessionId && admission.sessionId !== sessionId) return;
        active = null;
        admission.lease.release();
    };

    return {
        releaseAdmission,
        startCapture: async (args) => {
            if (active) {
                throw new VoiceCaptureBusyError(active.lease.owner);
            }
            const admission = input.admission.acquire(input.productOwner);
            if (admission.status === 'busy') {
                throw new VoiceCaptureBusyError(admission.activeOwner);
            }
            active = {
                sessionId: args.sessionId,
                lease: admission.lease,
            };
            try {
                await input.captureOwner.startCapture(args);
            } catch (error) {
                releaseAdmission(args.sessionId);
                throw error;
            }
        },
        stopCapture: (args) => input.captureOwner.stopCapture(args),
        stopSession: async (sessionId) => {
            try {
                await input.captureOwner.stopSession(sessionId);
            } finally {
                releaseAdmission(sessionId);
            }
        },
    };
}
