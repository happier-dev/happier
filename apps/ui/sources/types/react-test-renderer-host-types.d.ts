import 'react-test-renderer';
import type { ComponentProps, ElementType } from 'react';

declare module 'react-test-renderer' {
    interface ReactTestInstance {
        findByType(type: string): ReactTestInstance;
        findAllByType(type: string, options?: { deep: boolean }): ReactTestInstance[];
        findByType<T extends ElementType>(type: T): ReactTestInstance & { props: ComponentProps<T> };
        findAllByType<T extends ElementType>(type: T, options?: { deep: boolean }): Array<ReactTestInstance & { props: ComponentProps<T> }>;
    }

    interface ReactTestRenderer {
        findByType<T extends ElementType>(type: T): ReactTestInstance & { props: ComponentProps<T> };
        findAllByType<T extends ElementType>(type: T): Array<ReactTestInstance & { props: ComponentProps<T> }>;
    }
}
