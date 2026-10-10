import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createNavigationContainerRef, getStateFromPath, NavigationContainer, type NavigatorScreenParams } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

const Stack = createNativeStackNavigator();
type HydrationParamList = { app: NavigatorScreenParams<{ editor: { id: string } }> };
const navigation = createNavigationContainerRef<HydrationParamList>();
const ChildAdmission = React.createContext(false);
let setChildAdmission: React.Dispatch<React.SetStateAction<boolean>>;

function Editor() { return <div data-testid="hydration-editor" />; }
function AppScreen() {
    return React.useContext(ChildAdmission)
        ? <Stack.Navigator><Stack.Screen name="editor" component={Editor} /></Stack.Navigator>
        : <div data-testid="hydration-pending" />;
}
function HydrationJourney() {
    const [admitted, setAdmitted] = React.useState(false);
    setChildAdmission = setAdmitted;
    // The public linking parser supplies the same partial nested state that a
    // lazy Expo layout receives before its child navigator can register.
    const initialState = React.useMemo(() => getStateFromPath<HydrationParamList>('/workflows/saved', {
        screens: { app: { path: '', screens: { editor: 'workflows/:id' } } },
    }), []);
    return <ChildAdmission.Provider value={admitted}>
        <NavigationContainer ref={navigation} initialState={initialState}>
            <Stack.Navigator><Stack.Screen name="app" component={AppScreen} /></Stack.Navigator>
        </NavigationContainer>
    </ChildAdmission.Provider>;
}

export const navigationHydrationBrowser = {
    mount: () => createRoot(document.getElementById('root')!).render(<HydrationJourney />),
    isReady: () => navigation.isReady(),
    readState: () => navigation.getRootState(),
    admitChild: () => setChildAdmission(true),
    removeChild: () => setChildAdmission(false),
};
