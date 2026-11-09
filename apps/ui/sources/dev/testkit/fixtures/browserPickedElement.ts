import { jsxDEV } from 'react/jsx-dev-runtime';

/** Real React 19 JSX metadata; deliberately separate from the component's mounting callsite. */
export function React19FixtureSource() {
    return jsxDEV('button', { id: 'picked-source', children: 'Pick me' }, undefined, false);
}
