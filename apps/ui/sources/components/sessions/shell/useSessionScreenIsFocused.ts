import * as ReactNavigation from '@react-navigation/native';

export function useSessionScreenIsFocused(): boolean {
    const useIsFocused = (ReactNavigation as { useIsFocused?: () => boolean }).useIsFocused;
    return typeof useIsFocused === 'function' ? useIsFocused() : true;
}
