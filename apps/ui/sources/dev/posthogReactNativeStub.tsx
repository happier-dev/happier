import * as React from 'react';

type PostHogProperties = Record<string, unknown>;

export const __isHappierPostHogReactNativeStub = true;

export default class PostHog {
    constructor(_apiKey: string, _options?: PostHogProperties) {}

    capture(_eventName: string, _properties?: PostHogProperties): void {}

    identify(_distinctId: string, _properties?: PostHogProperties): void {}

    group(_groupType: string, _groupKey: string, _groupProperties?: PostHogProperties): void {}

    reset(): void {}

    async flush(): Promise<void> {}

    async optIn(): Promise<void> {}

    async optOut(): Promise<void> {}
}

export function PostHogProvider({ children }: Readonly<{ children?: React.ReactNode }>) {
    return React.createElement(React.Fragment, null, children);
}
