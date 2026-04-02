import { WebDesktopBackgroundServiceHandoffContent } from './WebDesktopBackgroundServiceHandoffContent';

export type WebDesktopBackgroundServiceHandoffStepProps = Readonly<{
    testID: string;
    relayUrl: string;
}>;

export function WebDesktopBackgroundServiceHandoffStep(props: WebDesktopBackgroundServiceHandoffStepProps) {
    return (
        <WebDesktopBackgroundServiceHandoffContent
            testID={props.testID}
            relayUrl={props.relayUrl}
        />
    );
}
