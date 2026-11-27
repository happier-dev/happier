import * as React from 'react';

import { presentRecordingStartRefusal, presentRecordingStopOutcome } from '@/components/browser/recording/recordingActions';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { RECORDING_FAILURE_SPECIMEN_STATES, type RecordingFailureSpecimenState } from './recordingFailureSpecimenStates';

/** Each typed result the Machine answers (protocol recording/results.ts, daemon encoderFailure.ts), through the shipped presenters. */
const PRESENT: Readonly<Record<RecordingFailureSpecimenState, () => void>> = {
    'start-not-owned': () => presentRecordingStartRefusal('recording_session_not_owned'),
    'start-session-unavailable': () => presentRecordingStartRefusal('recording_session_unavailable'),
    'start-encoder-unavailable': () => presentRecordingStartRefusal('encoder_unavailable'),
    'stop-not-saved-gone': () => presentRecordingStopOutcome({ status: 'failed', reason: 'media_persistence_failed', saveFailure: 'workspace_write_failed' }),
    'stop-not-saved-in-files': () => presentRecordingStopOutcome({ status: 'failed', reason: 'media_persistence_failed', saveFailure: 'transcript_attach_failed' }),
    'stop-not-saved': () => presentRecordingStopOutcome({ status: 'failed', reason: 'media_persistence_failed' }),
    // A Stop whose encoder failed to start (b9732f40b00, decc2ad58a5): its typed cause and request id under Technical details.
    'stop-capture-failed': () => presentRecordingStopOutcome({ status: 'failed', reason: 'capture_failed', requestId: 'stop-6f2c41d8',
        failureCause: { phase: 'recording.capture_stop', errorClass: 'Error', errorCode: null, httpStatus: null,
            nativeErrorCode: 'exit_1', nativeErrorReason: 'encoder_initialization_failed' } }),
    'stop-no-answer': () => presentRecordingStopOutcome(null),
};

/** Dev-only: `state` opens that result's message on arrival; the list opens any of them. */
export default function RecordingFailuresSpecimen(props: Readonly<{ state: RecordingFailureSpecimenState | null }>) {
    React.useEffect(() => { if (props.state) PRESENT[props.state](); }, [props.state]);
    return <ItemList>
        <ItemGroup title="Recording results">
            {RECORDING_FAILURE_SPECIMEN_STATES.map(state => (
                <Item key={state} testID={`recording-failure:${state}`} title={state} onPress={PRESENT[state]} />
            ))}
        </ItemGroup>
    </ItemList>;
}
