import { Redirect, useLocalSearchParams } from 'expo-router';

type AutomationPickerParams = Readonly<{
    automationEnabled?: string;
    automationName?: string;
    automationDescription?: string;
    automationScheduleKind?: string;
    automationEveryMinutes?: string;
    automationCronExpr?: string;
    automationTimezone?: string;
}>;

export default function LegacyAutomationPickerRoute() {
    const params = useLocalSearchParams<AutomationPickerParams>();

    return (
        <Redirect
            href={{
                pathname: '/new',
                params: {
                    automation: '1',
                    ...(typeof params.automationEnabled === 'string' ? { automationEnabled: params.automationEnabled } : {}),
                    ...(typeof params.automationName === 'string' ? { automationName: params.automationName } : {}),
                    ...(typeof params.automationDescription === 'string' ? { automationDescription: params.automationDescription } : {}),
                    ...(typeof params.automationScheduleKind === 'string' ? { automationScheduleKind: params.automationScheduleKind } : {}),
                    ...(typeof params.automationEveryMinutes === 'string' ? { automationEveryMinutes: params.automationEveryMinutes } : {}),
                    ...(typeof params.automationCronExpr === 'string' ? { automationCronExpr: params.automationCronExpr } : {}),
                    ...(typeof params.automationTimezone === 'string' ? { automationTimezone: params.automationTimezone } : {}),
                },
            }}
        />
    );
}
