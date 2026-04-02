import { WebDesktopRelayHostHandoffContent } from './WebDesktopRelayHostHandoffContent';

export type WebDesktopHandoffStepProps = Readonly<{
    testID: string;
}>;

export function WebDesktopHandoffStep(props: WebDesktopHandoffStepProps) {
    return <WebDesktopRelayHostHandoffContent testID={props.testID} />;
}
