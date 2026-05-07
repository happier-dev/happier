import * as React from 'react';
import { Redirect } from 'expo-router';

export default function ServerConfigRoute() {
    return <Redirect href="/settings/server" />;
}
