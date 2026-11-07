import { secondSpec } from './second.mjs';
import { lazyActionSpecArray } from '../../lazyActionSpecValue.ts';

export const firstSpec = Object.freeze({ id: 'first' });
export const specs = lazyActionSpecArray(() => Object.freeze([firstSpec, secondSpec]));
