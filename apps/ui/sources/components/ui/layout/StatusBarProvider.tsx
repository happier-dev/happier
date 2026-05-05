import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { useUnistyles } from 'react-native-unistyles';

import { resolveStatusBarStyleForDarkTheme } from './statusBarStyle';


export const StatusBarProvider = React.memo(() => {
    const { theme } = useUnistyles();
    const statusBarStyle = resolveStatusBarStyleForDarkTheme(theme.dark);
    return (
        <StatusBar style={statusBarStyle} animated={true} />
    );
});
