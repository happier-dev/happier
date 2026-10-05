import * as React from 'react';
import { View, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { TaskStatusPill } from './TaskSessionStatusPill';


export const TODO_HEIGHT = 56;

export type TodoViewProps = {
    id: string;
    done: boolean;
    value: string;
    onToggle?: () => void;
    reorderHandle?: React.ReactNode;
}

export const TodoView = React.memo<TodoViewProps>((props) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const handlePress = () => {
        router.push({
            pathname: '/zen/view',
            params: {
                id: props.id
            }
        });
    };

    return (
        <Pressable {...{ dataSet: { entityDragBody: 'true' } }} onPress={handlePress} style={{
            height: TODO_HEIGHT,
            width: '100%',
            borderRadius: 8,
            backgroundColor: theme.colors.surface.elevated,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 12
        }}>
            <Pressable
                onPress={(e) => {
                    e.stopPropagation();
                    props.onToggle?.();
                }}
                hitSlop={8}
                style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    borderWidth: 2,
                    borderColor: props.done ? theme.colors.state.success.foreground : theme.colors.text.secondary,
                    backgroundColor: props.done ? theme.colors.state.success.foreground : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 12
                }}
            >
                {props.done && (
                    <Icon name="check" size={16} color={theme.colors.button.primary.tint} />
                )}
            </Pressable>
            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text
                    style={{
                        paddingLeft: 4,
                        paddingRight: 4,
                        paddingTop: 0,
                        paddingBottom: 0,
                        alignSelf: 'center',
                        color: props.done ? theme.colors.text.secondary : theme.colors.text.primary,
                        fontSize: 18,
                        flexGrow: 1,
                        flexShrink: 1,
                        textDecorationLine: props.done ? 'line-through' : 'none',
                        opacity: props.done ? 0.6 : 1
                    }}
                    numberOfLines={1}
                >
                    {props.value}
                </Text>
                <TaskStatusPill taskId={props.id} />
            </View>
            {props.reorderHandle}
        </Pressable>
    );
});
