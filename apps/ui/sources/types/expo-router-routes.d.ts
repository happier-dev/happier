/* eslint-disable */
import * as Router from 'expo-router';

declare module 'expo-router' {
    export namespace ExpoRouter {
        /**
         * Project-level route typing fallback for custom app root layouts.
         *
         * We intentionally allow absolute app paths (`/${string}`) so typechecking
         * remains stable in CI/local even when Expo's generated `.expo/types/router.d.ts`
         * is unavailable or incomplete for grouped route trees.
         */
        export interface __routes<T extends string | object = string> {
            hrefInputParams:
                | { pathname: Router.RelativePathString; params?: Router.UnknownInputParams }
                | { pathname: Router.ExternalPathString; params?: Router.UnknownInputParams }
                | { pathname: `/${string}`; params?: Router.UnknownInputParams };
            hrefOutputParams:
                | { pathname: Router.RelativePathString; params?: Router.UnknownOutputParams }
                | { pathname: Router.ExternalPathString; params?: Router.UnknownOutputParams }
                | { pathname: `/${string}`; params?: Router.UnknownOutputParams };
            href:
                | Router.RelativePathString
                | Router.ExternalPathString
                | string
                | `/${string}`
                | { pathname: Router.RelativePathString; params?: Router.UnknownInputParams }
                | { pathname: Router.ExternalPathString; params?: Router.UnknownInputParams }
                | { pathname: string; params?: Router.UnknownInputParams }
                | { pathname: `/${string}`; params?: Router.UnknownInputParams };
        }
    }
}
