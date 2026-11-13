import { Redirect, useLocalSearchParams, type Href } from 'expo-router';
import { resolveZenTasksHref } from './zenTasksHref';

/** Retained Zen URLs address the same Account task through the Tasks page. */
export function ZenTasksRedirect() {
    // `/zen/[id]` and `/zen/view?id=` both reach this as the `id` param.
    const params = useLocalSearchParams<{ id?: string | string[] }>();
    const href = resolveZenTasksHref(params.id === undefined ? '/zen' : '/zen/view', params);
    return <Redirect href={href as Href} />;
}
