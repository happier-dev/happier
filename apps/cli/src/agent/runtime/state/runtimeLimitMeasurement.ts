type HostRuntimeAggregateMeasurementSample<Family extends string> = Readonly<{
    family: Family;
    decodedBytes: number;
    itemCount: number;
}>;

type HostRuntimeQueueMeasurementSample<Family extends string> = Readonly<{
    family: Family;
    queuedItems: number;
    queuedBytes: number;
    backpressured: boolean;
    sequence?: number;
}>;

export type HostRuntimeLimitMeasurementSample =
    | HostRuntimeAggregateMeasurementSample<'current-session-presentation'>
    | HostRuntimeAggregateMeasurementSample<'native-work-state-source'>
    | HostRuntimeAggregateMeasurementSample<'native-work-state-aggregate'>
    | HostRuntimeQueueMeasurementSample<'plugin-event-broker'>
    | HostRuntimeQueueMeasurementSample<'plugin-protocol-callbacks'>
    | HostRuntimeQueueMeasurementSample<'plugin-process-stdout'>
    | HostRuntimeQueueMeasurementSample<'plugin-process-stderr'>;

export type HostRuntimeLimitMeasurementRecorder = (
    sample: HostRuntimeLimitMeasurementSample,
) => void;
