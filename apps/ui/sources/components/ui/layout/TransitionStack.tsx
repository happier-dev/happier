import "react-native-reanimated";
import Transition, {
	type TransitionStackNavigatorTypeBag,
} from "react-native-screen-transitions";
import { withLayoutContext } from "expo-router";
import type { ParamListBase } from "@react-navigation/native";

const TransitionableStack: ReturnType<typeof Transition.createTransitionableStackNavigator<ParamListBase>> = Transition.createTransitionableStackNavigator();

type TransitionLayoutStack = ReturnType<typeof withLayoutContext<
	TransitionStackNavigatorTypeBag["ScreenOptions"],
	typeof TransitionableStack.Navigator,
	TransitionStackNavigatorTypeBag["State"],
	TransitionStackNavigatorTypeBag["EventMap"]
>>;

export const Stack: TransitionLayoutStack = withLayoutContext<
	TransitionStackNavigatorTypeBag["ScreenOptions"],
	typeof TransitionableStack.Navigator,
	TransitionStackNavigatorTypeBag["State"],
	TransitionStackNavigatorTypeBag["EventMap"]
>(TransitionableStack.Navigator);
