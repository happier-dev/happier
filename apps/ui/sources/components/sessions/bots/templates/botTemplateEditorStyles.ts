import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export const botTemplateEditorStyles = StyleSheet.create(theme => ({
    field: { ...Typography.variant('body'), color: theme.colors.text.primary },
}));
